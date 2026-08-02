const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env.local') });
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../public')));

// CORS headers for frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Mount API routes
const apiRoutes = require('./routes');
app.use('/api', apiRoutes);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Nifty OI Tracker running on http://localhost:${PORT}`);
  });
}

module.exports = app;