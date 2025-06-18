import os from 'os';

export default async function handler(req, res) {
  const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
  const usedMemMB = Math.round((os.totalmem() - os.freemem()) / 1024 / 1024);

  const uptimeSec = Math.floor(process.uptime());
  const uptimeMin = Math.floor(uptimeSec / 60);
  const uptimeHr = Math.floor(uptimeMin / 60);
  const uptimeStr = `${uptimeHr}h ${uptimeMin % 60}m`;

  const memoryUsage = `${usedMemMB} MB / ${totalMemMB} MB`;

  console.log("👋 Ping route hit");

  res.status(200).send(`
    ✅ Server Alive!<br>
    🧠 Notion Class Importer<br>
    💾 RAM Usage: ${memoryUsage}<br>
    ⏱️ Uptime: ${uptimeStr}<br>
    🌐 NODE_ENV: ${process.env.NODE_ENV || "undefined"}
  `);
}
