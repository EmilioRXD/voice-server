const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, "..")));

let minecraftData = null;
const clients = new Map(); // Map<WebSocket, { gamertag: string }>

app.post("/minecraft-data", (req, res) => {
  minecraftData = req.body;
  console.log("📦 Datos de Minecraft recibidos");

  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({
        type: 'minecraft-update',
        data: minecraftData
      }));
    }
  });

  res.json({ success: true });
});

wss.on("connection", (ws) => {
  console.log("🔌 Cliente conectado");

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.type === 'join') {
        clients.set(ws, { gamertag: data.gamertag });
        console.log(`👤 ${data.gamertag} se unió`);

        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify({
              type: 'join',
              gamertag: data.gamertag
            }));
          }
        });

        const participantsList = Array.from(clients.values()).map(c => c.gamertag);
        ws.send(JSON.stringify({
          type: 'participants-list',
          list: participantsList
        }));

        return;
      }

      if (data.type === 'leave') {
        const clientData = clients.get(ws);
        if (clientData) {
          console.log(`👋 ${clientData.gamertag} se fue`);

          wss.clients.forEach(client => {
            if (client !== ws && client.readyState === 1) {
              client.send(JSON.stringify({
                type: 'leave',
                gamertag: clientData.gamertag
              }));
            }
          });

          clients.delete(ws);
        }
        return;
      }

      if (data.type === 'offer' || data.type === 'answer' || data.type === 'ice-candidate') {
        if (!data.to || !data.from) {
          console.warn(`⚠️ Mensaje sin 'to' o 'from':`, data.type);
          return;
        }

        const targetGamertag = data.to;
        let targetWs = null;
        for (const [clientWs, clientData] of clients.entries()) {
          if (clientData.gamertag === targetGamertag) {
            targetWs = clientWs;
            break;
          }
        }

        if (targetWs && targetWs.readyState === 1) {
          targetWs.send(JSON.stringify(data));
          console.log(`📨 ${data.type} de ${data.from} → ${data.to}`);
        } else {
          console.warn(`⚠️ No se encontró destinatario: ${targetGamertag}`);
        }

        return;
      }

      if (data.type === 'heartbeat') return;

      if (data.type === 'request-participants') {
        const participantsList = Array.from(clients.values()).map(c => c.gamertag);
        ws.send(JSON.stringify({
          type: 'participants-list',
          list: participantsList
        }));
        return;
      }

    } catch (e) {
      console.error("Error procesando mensaje:", e);
    }
  });

  ws.on('close', () => {
    const clientData = clients.get(ws);
    if (clientData) {
      console.log(`🔌 ${clientData.gamertag} desconectado`);

      wss.clients.forEach(client => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({
            type: 'leave',
            gamertag: clientData.gamertag
          }));
        }
      });

      clients.delete(ws);
    }
  });

  if (minecraftData) {
    ws.send(JSON.stringify({
      type: 'minecraft-update',
      data: minecraftData
    }));
  }
});

server.listen(3000, () => {
  console.log("🌐 Servidor escuchando en puerto 3000");
  console.log("📡 WebSocket: ws://localhost:3000");
  console.log("🎮 Minecraft endpoint: POST http://localhost:3000/minecraft-data");
});
