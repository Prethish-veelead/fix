const app = require('../src/app');

module.exports = (req, res) => {
  if (req.url && req.url.startsWith('/debug-test')) {
    return res.end(JSON.stringify({
      url: req.url,
      originalUrl: req.originalUrl,
      headers: req.headers
    }, null, 2));
  }
  const matched = req.headers['x-matched-path'] || req.headers['x-now-route-matches'];
  if (matched && !matched.startsWith('/api')) {
    const qIndex = req.url.indexOf('?');
    const query = qIndex !== -1 ? req.url.slice(qIndex) : '';
    req.url = matched + query;
  }
  return app(req, res);
};
