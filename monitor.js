require('dotenv').config();
const { chromium } = require('playwright');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INTERVAL = (parseInt(process.env.CHECK_INTERVAL_SECONDS, 10) || 5) * 1000;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error('❌ ERROR CRÍTICO: Faltan credenciales de Telegram.');
  process.exit(1);
}

const DIAN_URL = 'https://agendamiento.dian.gov.co/';
const ESPERA_COLAPSO = 10000;
const TIMEOUT_MAX_RESPUESTA = 15000;

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Envió de Telegram sin bloquear la ejecución del script
async function enviarCapturaTelegram(buffer, mensaje, maxIntentos = 3) {
  const formData = new FormData();
  formData.append('chat_id', CHAT_ID);
  formData.append('caption', mensaje);
  formData.append('parse_mode', 'Markdown');

  let url = '';
  if (buffer) {
    formData.append('photo', new Blob([buffer]), 'captura.png');
    url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`;
  } else {
    formData.append('text', mensaje);
    url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  }

  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      await fetch(url, { method: 'POST', body: formData });
      break;
    } catch (err) {
      console.error(`❌ Fallo al enviar a Telegram (Intento ${intento}/${maxIntentos}):`, err.message);
      if (intento < maxIntentos) await esperar(2000);
    }
  }
}

// Promesa ultra-rápida utilizando los eventos nativos de Playwright
async function esperarResultadoUltraRapido(page, timeoutMs = TIMEOUT_MAX_RESPUESTA) {
  const cuadroLocator = page.locator('#control_204');
  const modalLocator = page.getByText('No se encontraron especialidades');

  try {
    return await Promise.race([
      cuadroLocator.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => 'cuadro'),
      modalLocator.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => 'modal')
    ]);
  } catch (e) {
    return 'timeout';
  }
}

async function iniciarMonitor() {
  console.log('🚀 Iniciando monitor ultra-rápido de la DIAN...');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    extraHTTPHeaders: {
      'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8'
    }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  await page.goto(DIAN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

  while (true) {
    try {
      console.log(`\n[${new Date().toLocaleTimeString('es-CO')}] Consultando disponibilidad...`);

      const botonInicio = page.locator('#control_209');
      if (!(await botonInicio.isVisible())) {
        await page.goto(DIAN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      // NAVEGACIÓN
      await page.locator('#control_209').click({ timeout: 10000 });
      await page.locator('div').filter({ hasText: /^PersonaNatural$/ }).first().click();
      await page.locator('div:nth-child(2) > .contentImgTipoAtencion > .img-fluid').click();
      await page.locator('div').filter({ hasText: /^Devoluciones\.$/ }).first().click();

      // DETECCIÓN EN TIEMPO REAL
      const resultado = await esperarResultadoUltraRapido(page, TIMEOUT_MAX_RESPUESTA);

      if (resultado === 'cuadro') {
        console.log('🚨 ¡HAY CITAS DETECTADAS! Tomando captura...');
        await page.locator('#control_204').click({ timeout: 5000 }).catch(() => {});
        
        const captura = await page.screenshot({ fullPage: true });

        // Se envía a Telegram en segundo plano sin pausar la ejecución
        enviarCapturaTelegram(
          captura,
          '🚨 *¡HAY CITAS EN LA DIAN!*\n\n' +
          '• Trámite: *Devoluciones*\n' +
          '• ¡El cuadro de sedes se habilitó!\n\n' +
          `[Ingresar a agendar de inmediato](${DIAN_URL})`
        );

        console.log(`Cita reportada. Pausa configurada (${INTERVAL / 1000}s)...`);
        await esperar(INTERVAL);
        await page.goto(DIAN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        continue;
      }

      if (resultado === 'modal') {
        console.log('ℹ️ Sin citas. Clic en Aceptar e inicio INMEDIATO del siguiente ciclo...');

        const botonAceptar = page.getByRole('button', { name: /Aceptar/i });
        await botonAceptar.click({ timeout: 3000 }).catch(async () => {
          await page.locator('text=Aceptar').first().click({ timeout: 2000 }).catch(() => {});
        });

        // Continuación inmediata sin pausas
        continue;
      }

      throw new Error('La página no mostró citas ni modal de error.');

    } catch (error) {
      console.warn(`⚠️ Error o timeout: ${error.message.split('\n')[0]}`);
      
      const segundosReintento = ESPERA_COLAPSO / 1000;
      
      page.screenshot({ timeout: 3000 }).then(capturaFallo => {
        enviarCapturaTelegram(capturaFallo, `⚠️ *Alerta DIAN:* La página no respondió. Reiniciando en ${segundosReintento}s...`);
      }).catch(() => {
        enviarCapturaTelegram(null, `⚠️ *Alerta DIAN:* La página no respondió. Reiniciando en ${segundosReintento}s...`);
      });

      await esperar(ESPERA_COLAPSO);
      await page.goto(DIAN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }
  }
}

iniciarMonitor();