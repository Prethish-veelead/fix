const app = require('../src/app');
const url = require('url');

module.exports = (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.query && parsed.query.__path !== undefined) {
    const rawPath = parsed.query.__path;
    const cleanPath = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
    delete parsed.query.__path;
    delete parsed.search;
    parsed.pathname = cleanPath;
    req.url = url.format(parsed);
  }
  return app(req, res);
};
