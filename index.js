const express = require('express');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ffmpeg-service', version: '4.0.0' });
});

/**
 * POST /process
 * Body: raw binary video
 * Returns: MP4 1080x1920 (9:16, black bars)
 *
 * ffmpeg reads from stdin (-i pipe:0) and writes to stdout (pipe:1)
 * No temp files needed — works within Railway's constraints
 */
app.post('/process', (req, res) => {
  console.log('[ffmpeg] starting pipe processing...');

  const args = [
    '-loglevel', 'error',
    '-i', 'pipe:0',                    // читаем из stdin
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', 'frag_keyframe+empty_moov+faststart', // нужно для pipe output (не seekable)
    '-f', 'mp4',
    'pipe:1'                           // пишем в stdout
  ];

  const ff = spawn('ffmpeg', args);

  let headersSent = false;
  let errOutput = '';

  // Собираем stderr для логов
  ff.stderr.on('data', (chunk) => {
    errOutput += chunk.toString();
  });

  // Как только первые байты выходят — отправляем заголовки и начинаем стримить
  ff.stdout.on('data', (chunk) => {
    if (!headersSent) {
      headersSent = true;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="output.mp4"');
      res.setHeader('Connection', 'close');
      console.log('[ffmpeg] first bytes received, streaming to client...');
    }
    res.write(chunk);
  });

  ff.stdout.on('end', () => {
    console.log('[ffmpeg] stdout ended');
    res.end();
  });

  ff.on('close', (code) => {
    console.log(`[ffmpeg] exited with code ${code}`);
    if (code !== 0) {
      console.error('[ffmpeg] stderr:', errOutput.slice(-2000));
      if (!headersSent) {
        res.status(500).json({ error: 'ffmpeg failed', code, detail: errOutput.slice(-500) });
      }
    }
  });

  ff.on('error', (err) => {
    console.error('[ffmpeg] spawn error:', err);
    if (!headersSent) {
      res.status(500).json({ error: 'Failed to start ffmpeg', detail: err.message });
    }
  });

  // Пайпим входящий запрос прямо в stdin ffmpeg
  req.pipe(ff.stdin);

  req.on('error', (err) => {
    console.error('[req] error:', err);
    ff.kill();
  });

  ff.stdin.on('error', (err) => {
    // EPIPE — нормально если ffmpeg завершился раньше
    if (err.code !== 'EPIPE') {
      console.error('[stdin] error:', err);
    }
  });
});

app.listen(PORT, () => {
  console.log(`ffmpeg-service v4 listening on port ${PORT}`);
});
