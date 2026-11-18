# data/

Aquí se guarda la información que usa el dashboard. El servidor crea los archivos la primera vez que arranca:

- `targets.json`  – IPs y URLs monitoreadas (nombre, etiquetas, checks). Se edita desde la vista **Objetivos**.
- `settings.json` – umbrales (latencia, SSL, disco…), intervalo por defecto, tema.
- `layout.json`   – ventanas del dashboard y su posición (organización Host).
- `users.json`    – usuarios y roles (contraseñas cifradas). Confidencial.
- `orgs.json`     – lista de organizaciones; la primera (`default`, "Host") es la principal.
- `orgs/<id>/targets.json` y `layout.json` – objetivos y ventanas de cada organización adicional.

Puedes respaldar o copiar esta carpeta a otro equipo. Los tokens de agentes se guardan aquí: protege la carpeta.
