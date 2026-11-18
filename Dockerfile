# Centinela · imagen de contenedor (Docker y Podman)
# Construir:  docker build -t centinela-monitor .      (o: podman build -t centinela-monitor .)
# Node 22 LTS (Node 20 sin soporte desde abril de 2026). Para builds reproducibles fija el digest: node:22-bookworm-slim@sha256:...
FROM node:22-bookworm-slim

# ping y traceroute reales (Alpine no sirve: su ping es de busybox y tiene otro formato de salida).
# setcap permite que el usuario sin privilegios use ICMP; si el sistema de archivos no lo admite, el compose
# trae además net.ipv4.ping_group_range, que cubre el mismo caso.
RUN apt-get update \
 && apt-get install -y --no-install-recommends iputils-ping traceroute libcap2-bin ca-certificates tzdata \
 && (setcap cap_net_raw+ep "$(command -v ping)" || true) \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY index.html ./
COPY assets ./assets
COPY js ./js
COPY server ./server
COPY agent ./agent

# Datos persistentes (targets, organizaciones, usuarios, ajustes). Móntalo como volumen para no perderlos.
RUN mkdir -p /data && chown -R node:node /data /app && chmod 700 /data
ENV NODE_ENV=production \
    PORT=9595 \
    HOST=0.0.0.0 \
    CENTINELA_DATA=/data
VOLUME ["/data"]
EXPOSE 9595

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]
