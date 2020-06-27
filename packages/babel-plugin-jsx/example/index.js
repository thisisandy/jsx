import { createApp, reactive, defineComponent } from 'vue';

const A = (_, { slots }) => <>{slots.default()}</>;

const B = defineComponent({
  setup() {
    const bindProps = reactive({ class: 'a', inner: 'children' });

    return {
      bindProps,
    };
  },
  methods: {
    onClick() {
      this.bindProps.class = 'b';
      this.bindProps.inner = 'x';
    },
  },
  render() {
    const { bindProps, onClick } = this;
    const children = <div class={bindProps.class} onClick={onClick}>{bindProps.inner}</div>;
    return (
      <A>
        {children}
      </A>
    );
  },
});

createApp({
  setup() {
    return () => <B />;
  },
}).mount('#app');

// app.mount('#app');
