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

// Función helper para encontrar si un gamertag ya existe
function isGamertagTaken(gamertag) {
  for (const [_, clientData] of clients.entries()) {
    if (clientData.gamertag === gamertag) {
      return true;
    }
  }
  return false;
}

// Función para broadcast a todos excepto al emisor
function broadcast(senderWs, message) {
  wss.clients.forEach(client => {
    if (client !== senderWs && client.readyState === 1) {
      client.send(JSON.stringify(message));
    }
  });
}

// Función para enviar a todos incluyendo al emisor
function broadcastToAll(message) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(message));
    }
  });
}

wss.on("connection", (ws) => {
  console.log("🔌 Cliente conectado");

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.type === 'join') {
        // Verificar si el gamertag ya está en uso
        if (isGamertagTaken(data.gamertag)) {
          console.log(`❌ Gamertag duplicado rechazado: ${data.gamertag}`);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Gamertag already in use. Please choose a different one.'
          }));
          ws.close();
          return;
        }

        clients.set(ws, { gamertag: data.gamertag });
        console.log(`👤 ${data.gamertag} se unió (${clients.size} usuarios en total)`);

        // Notificar a todos los demás que alguien se unió
        broadcast(ws, {
          type: 'join',
          gamertag: data.gamertag
        });

        // Obtener lista actualizada de participantes
        const participantsList = Array.from(clients.values()).map(c => c.gamertag);
        
        // Enviar lista completa al nuevo usuario
        ws.send(JSON.stringify({
          type: 'participants-list',
          list: participantsList
        }));

        // IMPORTANTE: También enviar la lista actualizada a TODOS los demás
        // Esto asegura que todos tengan la lista completa para establecer conexiones
        broadcast(ws, {
          type: 'participants-list',
          list: participantsList
        });

        return;
      }

      if (data.type === 'leave') {
        const clientData = clients.get(ws);
        if (clientData) {
          console.log(`👋 ${clientData.gamertag} se fue (${clients.size - 1} usuarios restantes)`);

          broadcast(ws, {
            type: 'leave',
            gamertag: clientData.gamertag
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
        
        // Buscar el WebSocket del destinatario
        for (const [clientWs, clientData] of clients.entries()) {
          if (clientData.gamertag === targetGamertag) {
            targetWs = clientWs;
            break;
          }
        }

        if (targetWs && targetWs.readyState === 1) {
          targetWs.send(JSON.stringify(data));
          
          // Log más detallado para debugging
          if (data.type === 'ice-candidate') {
            console.log(`🧊 ICE ${data.from} → ${data.to}`);
          } else {
            console.log(`📨 ${data.type} de ${data.from} → ${data.to}`);
          }
        } else {
          console.warn(`⚠️ No se encontró destinatario: ${targetGamertag}`);
        }

        return;
      }

      if (data.type === 'heartbeat') {
        // Solo para mantener la conexión viva
        return;
      }

      if (data.type === 'request-participants') {
        const participantsList = Array.from(clients.values()).map(c => c.gamertag);
        
        // Enviar lista al solicitante
        ws.send(JSON.stringify({
          type: 'participants-list',
          list: participantsList
        }));
        
        // IMPORTANTE: Broadcast la lista a TODOS para sincronización
        // Esto ayuda a mantener a todos sincronizados
        broadcastToAll({
          type: 'participants-list',
          list: participantsList
        });
        
        console.log(`📋 Lista de participantes enviada (${participantsList.length} usuarios)`);
        return;
      }

      console.warn(`⚠️ Tipo de mensaje desconocido: ${data.type}`);

    } catch (e) {
      console.error("❌ Error procesando mensaje:", e);
    }
  });

  ws.on('close', () => {
    const clientData = clients.get(ws);
    if (clientData) {
      console.log(`🔌 ${clientData.gamertag} desconectado (${clients.size - 1} usuarios restantes)`);

      // Notificar a todos que alguien se fue
      broadcast(ws, {
        type: 'leave',
        gamertag: clientData.gamertag
      });

      clients.delete(ws);
      
      // Opcional: Enviar lista actualizada después de que alguien se va
      const updatedList = Array.from(clients.values()).map(c => c.gamertag);
      broadcastToAll({
        type: 'participants-list',
        list: updatedList
      });
    }
  });

  ws.on('error', (error) => {
    const clientData = clients.get(ws);
    const gamertag = clientData ? clientData.gamertag : 'Unknown';
    console.error(`❌ Error en WebSocket para ${gamertag}:`, error.message);
  });

  // Si hay datos de Minecraft, enviarlos al nuevo cliente
  if (minecraftData) {
    ws.send(JSON.stringify({
      type: 'minecraft-update',
      data: minecraftData
    }));
  }
});

// Endpoint de salud para verificar que el servidor está funcionando
app.get("/health", (req, res) => {
  const status = {
    status: 'ok',
    connected_users: clients.size,
    minecraft_data: !!minecraftData,
    uptime: process.uptime()
  };
  res.json(status);
});

// Manejo de cierre limpio
process.on('SIGINT', () => {
  console.log('\n🛑 Apagando servidor...');
  
  // Notificar a todos los clientes
  broadcastToAll({ type: 'server-shutdown' });
  
  // Cerrar todas las conexiones
  wss.clients.forEach(client => {
    client.close();
  });
  
  server.close(() => {
    console.log('✅ Servidor cerrado');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 EnviroVoice Server v2.0`);
  console.log(`🌐 Servidor escuchando en puerto ${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`🎮 Minecraft endpoint: POST http://localhost:${PORT}/minecraft-data`);
  console.log(`💚 Health check: GET http://localhost:${PORT}/health`);
});
