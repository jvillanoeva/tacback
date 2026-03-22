require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const eventsRouter = require('./routes/events');
const staffRouter = require('./routes/staff');
const guestlistRouter = require('./routes/guestlist');
const checkinRouter = require('./routes/checkin');
const uploadRouter = require('./routes/upload');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.WEB_URL || '*',
  credentials: true,
}));
app.use(express.json({ limit: '6mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'colectivo-api', version: '2.0.0' });
});

// Routes
app.use('/api/events', eventsRouter);
app.use('/api/events/:slug/staff', staffRouter);
app.use('/api/events/:slug/guests', guestlistRouter);
app.use('/api/checkin', checkinRouter);
app.use('/api/upload', uploadRouter);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🎟️  Colectivo API v2.0.0 running on port ${PORT}`);
});
