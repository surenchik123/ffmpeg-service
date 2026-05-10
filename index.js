const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Multer: принимаем video + srt, до 500MB
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ffmpeg-service' });
});

/**
 * POST /process
 * multipart/form-data:
 *   - video: видеофайл (mp4, mkv, etc.)
 *   - srt:   субтитры (.srt)
 *
 * Возвращает обработанный MP4 (9:16, субтитры вшиты, чёрные полосы)
 */
app.post('/process', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'srt', maxCount: 1 }
]), async (req, res) => {
  const videoFile = req.files?.video?.[0];
  const srtFile   = req.files?.srt?.[0];

  if (!videoFile) {
    return res.status(400).json({ error: 'video file is required' });
  }

  const tmpDir    = os.tmpdir();
  const inputPath = videoFile.path;
  const outputPath = path.join(tmpDir, `out_${Date.now()}.mp4`);

  // Если srt передан — переименуем с расширением чтобы ffmpeg понял
  let srtPath = null;
  if (srtFile) {
    srtPath = path.join(tmpDir, `sub_${Date.now()}.srt`);
    fs.renameSync(srtFile.path, srtPath);
  }

  // ffmpeg filter:
  // 1. scale=1080:1920 с сохранением пропорций
  // 2. pad до 1080x1920 с чёрными полосами по центру
  // 3. subtitles= (если есть srt)
  const scaleAndPad = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black';
  const vf = srtPath
    ? `${scaleAndPad},subtitles='${srtPath.replace(/'/g, "'\\''")}':force_style='FontSize=18,PrimaryColour=&HFFFFFF,Outline=2'`
    : scaleAndPad;

  const args = [
    '-y',
    '-i', inputPath,
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath
  ];

  console.log(`[ffmpeg] starting: ${args.join(' ')}`);

  execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
    // Чистим входные файлы
    try { fs.unlinkSync(inputPath); } catch {}
    if (srtPath) try { fs.unlinkSync(srtPath); } catch {}

    if (err) {
      console.error('[ffmpeg] error:', stderr);
      return res.status(500).json({ error: 'ffmpeg failed', details: stderr.slice(-2000) });
    }

    console.log('[ffmpeg] done, sending file');

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="output.mp4"');

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => {
      try { fs.unlinkSync(outputPath); } catch {}
    });
    stream.on('error', (e) => {
      console.error('[stream] error:', e);
      try { fs.unlinkSync(outputPath); } catch {}
    });
  });
});

app.listen(PORT, () => {
  console.log(`ffmpeg-service listening on port ${PORT}`);
});
