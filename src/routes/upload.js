const { Router } = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { supabase } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = Router();

// Accept up to 5MB images
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, WebP, GIF, and SVG images are allowed'));
  },
});

// Wrap multer so filter / size errors return JSON 400 instead of falling through
// to the generic 500 handler.
function handleUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

router.post('/', requireAuth, handleUpload, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  const ext = EXT_BY_MIME[req.file.mimetype] || 'bin';
  const hash = crypto.randomBytes(4).toString('hex');
  const filename = `${req.user.id}/${Date.now()}-${hash}.${ext}`;

  const { data, error } = await supabase.storage
    .from('event-images')
    .upload(filename, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });

  if (error) {
    return res.status(500).json({ error: 'Upload failed: ' + error.message });
  }

  const { data: publicUrl } = supabase.storage
    .from('event-images')
    .getPublicUrl(filename);

  res.json({ url: publicUrl.publicUrl });
});

module.exports = router;
