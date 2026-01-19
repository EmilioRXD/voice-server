
const server = Bun.serve({
    port: 8080,
    fetch(req) {
        const url = new URL(req.url);
        let path = url.pathname;

        if (path === "/") path = "/index.html";

        const file = Bun.file("." + path);
        return new Response(file);
    },
});

console.log(`🚀 Servidor de EnviroVoice corriendo en http://localhost:${server.port}`);
