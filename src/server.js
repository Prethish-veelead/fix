const app = require('./app');
const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => console.log(`FixMitra is running on port ${port}`));
