const { Router } = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { supabase } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = Router();

// Accept up to 5MB images
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed'));
    }
  },
});

router.post('/', requireAuth, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  const ext = req.file.mimetype.split('/')[1].replace('jpeg', 'jpg');
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
