const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ffmpeg-service' });
});

/**
 * POST /process
 * Content-Type: video/mp4 (или любой video/*)
 * Body: raw binary video file
 *
 * Возвращает MP4 1080x1920 (9:16, чёрные полосы)
 */
app.post('/process', (req, res) => {
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `in_${Date.now()}.mp4`);
  const outputPath = path.join(tmpDir, `out_${Date.now()}.mp4`);

  // Пишем входящий поток в файл
  const writeStream = fs.createWriteStream(inputPath);
  req.pipe(writeStream);

  writeStream.on('error', (err) => {
    console.error('[write] error:', err);
    res.status(500).json({ error: 'Failed to write input file' });
  });

  writeStream.on('finish', () => {
    const stat = fs.statSync(inputPath);
    console.log(`[ffmpeg] input size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

    const args = [
      '-y',
      '-i', inputPath,
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath
    ];

    console.log(`[ffmpeg] starting...`);

    execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(inputPath); } catch {}

      if (err) {
        console.error('[ffmpeg] error:', stderr.slice(-2000));
        try { fs.unlinkSync(outputPath); } catch {}
        return res.status(500).json({ error: 'ffmpeg failed', details: stderr.slice(-2000) });
      }

      const outStat = fs.statSync(outputPath);
      console.log(`[ffmpeg] done, output size: ${(outStat.size / 1024 / 1024).toFixed(1)} MB`);

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="output.mp4"');
      res.setHeader('Content-Length', outStat.size);

      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);
      stream.on('end', () => { try { fs.unlinkSync(outputPath); } catch {} });
      stream.on('error', (e) => {
        console.error('[stream] error:', e);
        try { fs.unlinkSync(outputPath); } catch {}
      });
    });
  });
});

app.listen(PORT, () => {
  console.log(`ffmpeg-service listening on port ${PORT}`);
});
