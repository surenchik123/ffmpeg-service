const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Используем /app/tmp — гарантированно есть место на Railway
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ffmpeg-service', version: '5.0.0' });
});

/**
 * POST /process
 * Body: raw binary video
 * Returns: MP4 1080x1920 (9:16, black bars)
 */
app.post('/process', (req, res) => {
  const ts = Date.now();
  const inputPath = path.join(TMP_DIR, `in_${ts}.mp4`);
  const outputPath = path.join(TMP_DIR, `out_${ts}.mp4`);

  console.log(`[${ts}] writing input...`);

  const writeStream = fs.createWriteStream(inputPath);
  req.pipe(writeStream);

  writeStream.on('error', (err) => {
    console.error(`[${ts}] write error:`, err.message);
    cleanup(inputPath);
    if (!res.headersSent) res.status(500).json({ error: 'write failed', detail: err.message });
  });

  writeStream.on('finish', () => {
    const inputSize = fs.statSync(inputPath).size;
    console.log(`[${ts}] input written: ${(inputSize / 1024 / 1024).toFixed(1)} MB`);

    if (inputSize === 0) {
      cleanup(inputPath);
      return res.status(400).json({ error: 'empty input file' });
    }

    const args = [
      '-y',
      '-loglevel', 'warning',
      '-i', inputPath,
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',   // быстрее = меньше памяти одновременно
      '-crf', '26',             // чуть хуже качество, зато меньше размер
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      outputPath
    ];

    console.log(`[${ts}] starting ffmpeg...`);

    const child = execFile('ffmpeg', args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 5 * 60 * 1000  // 5 минут максимум
    }, (err, _stdout, stderr) => {
      cleanup(inputPath);

      if (err) {
        console.error(`[${ts}] ffmpeg error (code=${err.code}, signal=${err.signal}):`, stderr.slice(-500));
        cleanup(outputPath);
        if (!res.headersSent) {
          return res.status(500).json({
            error: 'ffmpeg failed',
            code: err.code,
            signal: err.signal,
            detail: stderr.slice(-300)
          });
        }
        return;
      }

      // Проверяем что файл реально создался
      if (!fs.existsSync(outputPath)) {
        console.error(`[${ts}] output file missing`);
        if (!res.headersSent) return res.status(500).json({ error: 'output file not created' });
        return;
      }

      const outputSize = fs.statSync(outputPath).size;
      console.log(`[${ts}] output ready: ${(outputSize / 1024 / 1024).toFixed(1)} MB`);

      if (outputSize === 0) {
        cleanup(outputPath);
        if (!res.headersSent) return res.status(500).json({ error: 'output file is empty' });
        return;
      }

      // Читаем в буфер и отправляем
      fs.readFile(outputPath, (readErr, data) => {
        cleanup(outputPath);

        if (readErr) {
          console.error(`[${ts}] read error:`, readErr.message);
          if (!res.headersSent) return res.status(500).json({ error: 'read failed' });
          return;
        }

        console.log(`[${ts}] sending ${(data.length / 1024 / 1024).toFixed(1)} MB to client`);

        res.set({
          'Content-Type': 'video/mp4',
          'Content-Disposition': 'attachment; filename="output.mp4"',
          'Content-Length': data.length,
          'Connection': 'close'
        });
        res.end(data);
      });
    });

    child.on('error', (spawnErr) => {
      console.error(`[${ts}] spawn error:`, spawnErr.message);
    });
  });
});

function cleanup(...paths) {
  for (const p of paths) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

app.listen(PORT, () => {
  console.log(`ffmpeg-service v5 listening on port ${PORT}`);
  console.log(`tmp dir: ${TMP_DIR}`);
});
