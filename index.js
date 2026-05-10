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
 * Body: raw binary video (any format ffmpeg supports)
 * Returns: processed MP4 1080x1920 (9:16, black bars)
 */
app.post('/process', (req, res) => {
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const inputPath = path.join(tmpDir, `in_${ts}.mp4`);
  const outputPath = path.join(tmpDir, `out_${ts}.mp4`);

  const writeStream = fs.createWriteStream(inputPath);
  req.pipe(writeStream);

  writeStream.on('error', (err) => {
    console.error('[write] error:', err);
    cleanup(inputPath, outputPath);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to write input' });
  });

  writeStream.on('finish', () => {
    const stat = fs.statSync(inputPath);
    console.log(`[ffmpeg] input: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

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

    execFile('ffmpeg', args, { maxBuffer: 50 * 1024 * 1024 }, (err, _stdout, stderr) => {
      cleanup(inputPath);

      if (err) {
        console.error('[ffmpeg] failed:', stderr.slice(-1000));
        cleanup(outputPath);
        if (!res.headersSent) res.status(500).json({ error: 'ffmpeg failed', detail: stderr.slice(-500) });
        return;
      }

      const outStat = fs.statSync(outputPath);
      console.log(`[ffmpeg] output: ${(outStat.size / 1024 / 1024).toFixed(1)} MB`);

      // Читаем файл в память и отправляем как буфер — избегаем проблем с потоками в n8n
      fs.readFile(outputPath, (readErr, data) => {
        cleanup(outputPath);

        if (readErr) {
          console.error('[read] error:', readErr);
          if (!res.headersSent) res.status(500).json({ error: 'Failed to read output' });
          return;
        }

        res.set({
          'Content-Type': 'video/mp4',
          'Content-Disposition': 'attachment; filename="output.mp4"',
          'Content-Length': data.length,
          'Connection': 'close'
        });
        res.end(data);
      });
    });
  });
});

function cleanup(...paths) {
  for (const p of paths) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

app.listen(PORT, () => {
  console.log(`ffmpeg-service v3 listening on port ${PORT}`);
});
