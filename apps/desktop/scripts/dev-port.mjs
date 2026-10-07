import { createServer } from 'node:net';

export async function findAvailablePort(startPort = 5174, host = '127.0.0.1') {
  for (let port = startPort; port <= 65535; port += 1) {
    const available = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE') resolve(false);
        else reject(error);
      });
      server.listen(port, host, () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error('No available port for the desktop frontend.');
}
