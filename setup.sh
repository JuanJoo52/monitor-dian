#!/bin/bash
set -e

echo "📦 1/4 Instalando paquetes de Node..."
npm install

echo "🌐 2/4 Descargando Chromium para Playwright..."
npx playwright install chromium

echo "🐧 3/4 Instalando librerías del sistema operativo..."
sudo npx playwright install-deps

# Crea el .env si no existe
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    echo "📄 Creando archivo .env base..."
    cp .env.example .env
  else
    touch .env
  fi
  echo "⚠️ Recuerda configurar tus tokens en el .env ('nano .env')."
fi

# Instala PM2 si no está presente
if ! command -v pm2 &> /dev/null; then
  echo "⚙️ Instalando PM2..."
  sudo npm install -g pm2
fi

echo "🚀 4/4 Arrancando el bot con PM2..."
pm2 start monitor.js --name "monitor-dian"
pm2 save

echo "✅ Proceso completado. El monitor ya está activo."
pm2 status