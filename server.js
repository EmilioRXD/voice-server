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
const pttStates = new Map(); // Map<gamertag, { isTalking: boolean, isMuted: boolean }>

app.post("/minecraft-data", (req, res) => {
  minecraftData = req.body;
  console.log("📦 Datos de Minecraft recibidos");

  // NUEVO: Preparar estados de mute para enviar a los clientes
  const muteStates = minecraftData.players?.map(player => ({
    gamertag: player.name,
    isMuted: player.data.isMuted,
    isDeafened: player.data.isDeafened,
    micVolume: player.data.micVolume
  })) || [];

  // Incluir estados de PTT en la respuesta
  const pttStatesArray = Array.from(pttStates.entries()).map(([gamertag, state]) => ({
    gamertag,
    ...state
  }));

  // CRÍTICO: Enviar datos de Minecraft + estados de mute + estados PTT a todos los clientes
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({
        type: 'minecraft-update',
        data: minecraftData,
        muteStates: muteStates,  // NUEVO: Estados de mute desde Minecraft
        pttStates: pttStatesArray
      }));
    }
  });

  // Responder con los estados de PTT para que Minecraft los procese
  res.json({ 
    success: true,
    pttStates: pttStatesArray
  });
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
        
        // Inicializar estado de PTT para este jugador
        pttStates.set(data.gamertag, { isTalking: true, isMuted: false });
        
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

        // También enviar la lista actualizada a TODOS los demás
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

          pttStates.delete(clientData.gamertag);
          clients.delete(ws);
        }
        return;
      }

      // Manejar estado de Push-to-Talk
      if (data.type === 'ptt-status') {
        const gamertag = data.gamertag;
        const isTalking = data.isTalking;
        const isMuted = data.isMuted;

        // Guardar estado
        pttStates.set(gamertag, { isTalking, isMuted });

        console.log(`🎙️ PTT: ${gamertag} → ${isTalking ? 'TALKING' : 'MUTED'}`);

        // Retransmitir a TODOS
        broadcastToAll({
          type: 'ptt-update',
          gamertag: gamertag,
          isTalking: isTalking,
          isMuted: isMuted
        });

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
        
        ws.send(JSON.stringify({
          type: 'participants-list',
          list: participantsList
        }));
        
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

      broadcast(ws, {
        type: 'leave',
        gamertag: clientData.gamertag
      });

      pttStates.delete(clientData.gamertag);
      clients.delete(ws);
      
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

// Endpoint de salud
app.get("/health", (req, res) => {
  const status = {
    status: 'ok',
    connected_users: clients.size,
    minecraft_data: !!minecraftData,
    ptt_active_users: pttStates.size,
    uptime: process.uptime()
  };
  res.json(status);
});

// Endpoint para obtener estados de PTT
app.get("/ptt-states", (req, res) => {
  const states = Array.from(pttStates.entries()).map(([gamertag, state]) => ({
    gamertag,
    ...state
  }));
  res.json({ pttStates: states });
});

// Manejo de cierre limpio
process.on('SIGINT', () => {
  console.log('\n🛑 Apagando servidor...');
  
  broadcastToAll({ type: 'server-shutdown' });
  
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
  console.log(`🚀 EnviroVoice Server v2.1`);
  console.log(`🌐 Servidor escuchando en puerto ${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`🎮 Minecraft endpoint: POST http://localhost:${PORT}/minecraft-data`);
  console.log(`💚 Health check: GET http://localhost:${PORT}/health`);
  console.log(`🎙️ PTT states: GET http://localhost:${PORT}/ptt-states`);
});
