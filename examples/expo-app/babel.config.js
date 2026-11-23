// @x402/core lazy-loads its server-side paywall with import(), which Hermes cannot compile; the phone never uses it, and x402 already catches the rejection.
const rejectImport = ({ types: t, template }) => ({
  visitor: {
    CallExpression(path) {
      if (t.isImport(path.node.callee)) path.replaceWith(template.expression.ast`Promise.reject(new Error('x402 paywall is server-only'))`);
    },
  },
});

module.exports = api => {
  api.cache(true);
  return {
    presets: [require.resolve('babel-preset-expo', { paths: [require.resolve('expo/package.json')] })],
    // test is a function because Expo loads this config once without a filename
    overrides: [{ test: file => /node_modules[\\/]@x402[\\/]core[\\/]/.test(file ?? ''), plugins: [rejectImport] }],
  };
};
