require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const eventsRouter = require('./routes/events');
const staffRouter = require('./routes/staff');
const guestlistRouter = require('./routes/guestlist');
const checkinRouter = require('./routes/checkin');
const uploadRouter = require('./routes/upload');
const reportRouter = require('./routes/report');
const inviteRouter = require('./routes/invite');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    const allowed = (process.env.WEB_URL || '').split(',').map(s => s.trim()).filter(Boolean);
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || allowed.length === 0 || allowed.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // permissive for now — auth layer protects routes
    }
  },
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
app.use('/api/events/:slug/report', reportRouter);
app.use('/api/events/:slug/invite-links', inviteRouter);
app.use('/api/invite', inviteRouter);

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
