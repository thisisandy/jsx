import { addDefault, addNamespace } from '@babel/helper-module-imports';
import {
  createIdentifier,
  PatchFlags,
  PatchFlagNames,
  isDirective,
  checkIsComponent,
  getTag,
  getJSXAttributeName,
  transformJSXText,
  transformJSXExpressionContainer,
  transformJSXSpreadChild,
  parseDirectives,
  isFragment,
} from './utils';
import { JSXPath, JSXChildrenPath, State, JSXAttriPath, T } from './types';
import { NodePath } from "@babel/traverse";
import { ArrayExpression, ObjectProperty, CallExpression, JSXSpreadAttribute, Expression, ObjectExpression, NullLiteral } from '@babel/types';
import * as t from '@babel/types'

const xlinkRE = /^xlink([A-Z])/;
const onRE = /^on[^a-z]/;

const isOn = (key: string) => onRE.test(key);



const transformJSXSpreadAttribute = (path: NodePath<JSXSpreadAttribute>, mergeArgs: (NodePath<ObjectExpression> | Expression)[]) => {
  const argument = path.get<'argument'>('argument') as NodePath<ObjectExpression>;
  const { properties } = argument.node;
  if (!properties) {
    // argument is an Identifier
    mergeArgs.push(argument);
  } else {
    mergeArgs.push(t.objectExpression(properties));
  }
};

const getJSXAttributeValue = (path: JSXAttriPath, state: State) => {
  const valuePath = path.get<'value'>('value');
  if (valuePath.isJSXElement()) {
    return transformJSXElement(valuePath, state);
  }
  if (valuePath.isStringLiteral()) {
    return valuePath.node;
  }
  if (valuePath.isJSXExpressionContainer()) {
    return transformJSXExpressionContainer(valuePath);
  }

  return null;
};

/**
 *  Check if an attribute value is constant
 * @param t
 * @param path
 * @returns boolean
 */
const isConstant = (node: object | null): boolean => {
  if (t.isIdentifier(node)) {
    return node.name === 'undefined';
  }
  if (t.isArrayExpression(node)) {
    const elements = node.elements
    return elements.every((element) => element && isConstant(element));
  }
  if (t.isObjectExpression(node)) {
    return node.properties.every((property) => isConstant(property.value));
  }
  if (t.isLiteral(node)) {
    return true;
  }
  return false;
};

const mergeAsArray = (existing: object, incoming: object) => {
  if (t.isArrayExpression(existing.value)) {
    existing.value.elements.push(incoming.value);
  } else {
    existing.value = t.arrayExpression([
      existing.value,
      incoming.value,
    ]);
  }
};

const dedupeProperties = (properties: ObjectProperty[] = []) => {
  const knownProps = new Map<string, ObjectProperty>();
  const deduped: ObjectProperty[] = [];
  properties.forEach((prop) => {
    const { key: { value: name } = {} } = prop;
    const existing = knownProps.get(name);
    if (existing) {
      if (name === 'style' || name === 'class' || name.startsWith('on')) {
        mergeAsArray(existing, prop);
      }
    } else {
      knownProps.set(name, prop);
      deduped.push(prop);
    }
  });

  return deduped;
};

const buildProps = (path: JSXPath, state: State, hasContainer: boolean) => {
  const tag = getTag(path);
  const isComponent = checkIsComponent(path.get<'openingElement'>('openingElement'));
  const props = path.get<'openingElement'>('openingElement').get<'attributes'>('attributes');
  const directives: ArrayExpression[] = [];
  const dynamicPropNames = new Set();

  let patchFlag = 0;

  if (isFragment(path.get('openingElement').get<'name'>('name'))) {
    patchFlag |= PatchFlags.STABLE_FRAGMENT;
  } else if (hasContainer) {
    patchFlag |= PatchFlags.BAIL;
  }

  if (props.length === 0) {
    return {
      tag,
      props: t.nullLiteral(),
      directives,
      patchFlag,
      dynamicPropNames,
    };
  }

  const properties: ObjectProperty[] = [];

  // patchFlag analysis
  let hasRef = false;
  let hasClassBinding = false;
  let hasStyleBinding = false;
  let hasHydrationEventBinding = false;
  let hasDynamicKeys = false;

  const mergeArgs: (CallExpression | ObjectProperty)[] = [];

  props
    .forEach((prop) => {
      if (prop.isJSXAttribute()) {
        let name = getJSXAttributeName(prop) as string;

        const attributeValue = getJSXAttributeValue(prop, state);

        if (!isConstant(attributeValue) || name === 'ref') {
          if (
            !isComponent
            && isOn(name)
            // omit the flag for click handlers becaues hydration gives click
            // dedicated fast path.
            && name.toLowerCase() !== 'onclick'
            // omit v-model handlers
            && name !== 'onUpdate:modelValue'
          ) {
            hasHydrationEventBinding = true;
          }

          if (name === 'ref') {
            hasRef = true;
          } else if (name === 'class' && !isComponent) {
            hasClassBinding = true;
          } else if (name === 'style' && !isComponent) {
            hasStyleBinding = true;
          } else if (
            name !== 'key'
            && !isDirective(name)
            && name !== 'on'
          ) {
            dynamicPropNames.add(name);
          }
        }
        if (state.opts.transformOn && (name === 'on' || name === 'nativeOn')) {
          if (!state.get('transformOn')) {
            state.set('transformOn', addDefault(
              path,
              '@ant-design-vue/babel-helper-vue-transform-on',
              { nameHint: '_transformOn' },
            ));
          }
          mergeArgs.push(t.callExpression(
            state.get('transformOn'),
            [attributeValue || t.booleanLiteral(true)],
          ));
          return;
        }
        if (isDirective(name)) {
          const { directive, modifiers, directiveName } = parseDirectives(
            {
              tag,
              isComponent,
              name,
              path: prop,
              state,
              value: attributeValue,
            },
          );

          if (directive) {
            directives.push(t.arrayExpression(directive));
          } {
            // must be v-model and is a component
            properties.push(t.objectProperty(
              t.stringLiteral('modelValue'),
              attributeValue,
            ));

            dynamicPropNames.add('modelValue');

            if (modifiers.size) {
              properties.push(t.objectProperty(
                t.stringLiteral('modelModifiers'),
                t.objectExpression(
                  [...modifiers].map((modifier) => (
                    t.objectProperty(
                      t.stringLiteral(modifier),
                      t.booleanLiteral(true),
                    )
                  )),
                ),
              ));
            }
          }

          if (directiveName === 'model' && attributeValue) {
            properties.push(t.objectProperty(
              t.stringLiteral('onUpdate:modelValue'),
              t.arrowFunctionExpression(
                [t.identifier('$event')],
                t.assignmentExpression('=', attributeValue, t.identifier('$event')),
              ),
            ));

            dynamicPropNames.add('onUpdate:modelValue');
          }
          return;
        }
        if (name.match(xlinkRE)) {
          name = name.replace(xlinkRE, (_, firstCharacter) => `xlink:${firstCharacter.toLowerCase()}`);
        }
        properties.push(t.objectProperty(
          t.stringLiteral(name),
          attributeValue || t.booleanLiteral(true),
        ));
      } else {
        hasDynamicKeys = true;
        transformJSXSpreadAttribute(prop, mergeArgs);
      }
    });

  // patchFlag analysis
  if (hasDynamicKeys) {
    patchFlag |= PatchFlags.FULL_PROPS;
  } else {
    if (hasClassBinding) {
      patchFlag |= PatchFlags.CLASS;
    }
    if (hasStyleBinding) {
      patchFlag |= PatchFlags.STYLE;
    }
    if (dynamicPropNames.size) {
      patchFlag |= PatchFlags.PROPS;
    }
    if (hasHydrationEventBinding) {
      patchFlag |= PatchFlags.HYDRATE_EVENTS;
    }
  }

  if (
    (patchFlag === 0 || patchFlag === PatchFlags.HYDRATE_EVENTS)
    && (hasRef || directives.length > 0)
  ) {
    patchFlag |= PatchFlags.NEED_PATCH;
  }

  let propsExpression: CallExpression | NullLiteral | ObjectExpression | ObjectProperty = t.nullLiteral();

  if (mergeArgs.length) {
    if (properties.length) {
      mergeArgs.push(...dedupeProperties(properties));
    }
    if (mergeArgs.length > 1) {
      const exps: CallExpression[] = [];
      const objectProperties: ObjectProperty[] = [];
      mergeArgs.forEach((arg) => {
        if (t.isIdentifier(arg) || t.isExpression(arg)) {
          exps.push(arg);
        } else {
          objectProperties.push(arg);
        }
      });
      if (objectProperties.length) {
        propsExpression = t.callExpression(
          createIdentifier(state, 'mergeProps'),
          [
            ...exps,
            t.objectExpression(objectProperties),
          ].filter(Boolean),
        );
      }
    } else {
      // single no need for a mergeProps call
      // eslint-disable-next-line prefer-destructuring
      propsExpression = mergeArgs[0];
    }
  } else if (properties.length) {
    propsExpression = t.objectExpression(dedupeProperties(properties));
  }

  return {
    tag,
    props: propsExpression,
    directives,
    patchFlag,
    dynamicPropNames,
  };
};

/**
 * Get children from Array of JSX children
 * @param t
 * @param paths Array<JSXText | JSXExpressionContainer | JSXSpreadChild | JSXElement>
 * @returns Array<Expression | SpreadElement>
 */
const getChildren = (paths: JSXChildrenPath[], state: State) => {
  let hasContainer = false;
  return {
    children: paths
      .map((path) => {
        if (path.isJSXText()) {
          return transformJSXText(path);
        }
        if (path.isJSXExpressionContainer()) {
          hasContainer = true;
          return transformJSXExpressionContainer(path);
        }
        if (path.isJSXSpreadChild()) {
          return transformJSXSpreadChild(path);
        }
        if (path.isCallExpression()) {
          return path.node;
        }
        if (path.isJSXElement()) {
          return transformJSXElement(path, state);
        }
        throw new Error(`getChildren: ${path.type} is not supported`);
      }).filter((value) => (
        value !== undefined
        && value !== null
        && !t.isJSXEmptyExpression(value)
      )),
    hasContainer,
  };
};

const transformJSXElement = (path: JSXPath, state: State) => {
  const { children, hasContainer } = getChildren(path.get('children'), state);
  const {
    tag,
    props,
    directives,
    patchFlag,
    dynamicPropNames,
  } = buildProps(path, state, hasContainer);

  const flagNames = Object.keys(PatchFlagNames)
    .map(Number)
    .filter((n) => n > 0 && patchFlag & n)
    .map((n) => PatchFlagNames[n])
    .join(', ');

  const isComponent = checkIsComponent(path.get('openingElement'));
  const child = children.length === 1 && t.isStringLiteral(children[0])
    ? children[0] : t.arrayExpression(children);

  const { compatibleProps } = state.opts;
  if (compatibleProps && !state.get('compatibleProps')) {
    state.set('compatibleProps', addDefault(
      path, '@ant-design-vue/babel-helper-vue-compatible-props', { nameHint: '_compatibleProps' },
    ));
  }

  const createVNode = t.callExpression(createIdentifier(state, 'createVNode'), [
    tag,
    compatibleProps ? t.callExpression(state.get('compatibleProps'), [props]) : props,
    children[0]
      ? (
        isComponent
          ? t.objectExpression([
            t.objectProperty(
              t.identifier('default'),
              t.callExpression(createIdentifier(state, 'withCtx'), [
                t.arrowFunctionExpression(
                  [],
                  t.isStringLiteral(child)
                    ? t.callExpression(
                      createIdentifier(state, 'createTextVNode'),
                      [child],
                    )
                    : child,
                ),
              ]),
            ),
          ])
          : child
      ) : t.nullLiteral(),
    patchFlag && t.addComment(t.numericLiteral(patchFlag), 'trailing', ` ${flagNames} `, false),
    dynamicPropNames.size
    && t.arrayExpression([...dynamicPropNames.keys()].map((name) => t.stringLiteral(name as string))),
  ].filter(Boolean));

  if (!directives.length) {
    return createVNode;
  }

  return t.callExpression(createIdentifier(state, 'withDirectives'), [
    createVNode,
    t.arrayExpression(directives),
  ]);
};

export default () => ({
  JSXElement: {
    exit(path: JSXPath, state: State) {
      if (!state.get('vue')) {
        state.set('vue', addNamespace(path, 'vue'));
      }
      path.replaceWith(
        transformJSXElement(path, state),
      );
    },
  },
});