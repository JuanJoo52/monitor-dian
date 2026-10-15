require('dotenv').config();
const { chromium } = require('playwright');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INTERVAL = (parseInt(process.env.CHECK_INTERVAL_SECONDS, 10)) * 1000;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error('❌ ERROR CRÍTICO: Faltan credenciales de Telegram.');
  process.exit(1);
}

const DIAN_URL = 'https://agendamiento.dian.gov.co/';
const ESPERA_COLAPSO = 10000;
const TIMEOUT_MAX_RESPUESTA = 15000; // tope máximo, pero reacciona apenas detecta algo
const POLL_MS = 250; // cada cuánto revisa mientras espera la respuesta

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
      if (intento < maxIntentos) await esperar(3000);
    }
  }
}

// Revisa en loop corto cuál de los dos resultados posibles aparece primero
// (el cuadro de sedes o el modal de "sin citas"), en vez de esperar un tiempo
// fijo o esperar el timeout completo de uno antes de chequear el otro.
async function esperarResultado(page, maxMs = TIMEOUT_MAX_RESPUESTA) {
  const cuadroLocator = page.locator('#control_204');
  const modalLocator = page.getByText('No se encontraron especialidades');

  const inicio = Date.now();
  while (Date.now() - inicio < maxMs) {
    if (await cuadroLocator.isVisible().catch(() => false)) return 'cuadro';
    if (await modalLocator.isVisible().catch(() => false)) return 'modal';
    await esperar(POLL_MS);
  }
  return 'timeout';
}

async function iniciarMonitor() {
  console.log('🚀 Iniciando monitor optimizado de la DIAN...');

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

  // Primera carga completa de la página
  await page.goto(DIAN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

  while (true) {
    try {
      console.log(`\n[${new Date().toLocaleTimeString('es-CO')}] Consultando disponibilidad...`);

      // 1. Asegurar que estamos en el punto de partida (si por alguna razón se desvió, recarga)
      const botonInicio = page.locator('#control_209');
      const inicioVisible = await botonInicio.isVisible();
      if (!inicioVisible) {
        await page.goto(DIAN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      // --- PASOS DE NAVEGACIÓN ---
      await page.locator('#control_209').click({ timeout: 15000 });
      await page.locator('div').filter({ hasText: /^PersonaNatural$/ }).first().click();
      await page.locator('div:nth-child(2) > .contentImgTipoAtencion > .img-fluid').click();
      await page.locator('div').filter({ hasText: /^Devoluciones\.$/ }).first().click();

      console.log('Evaluando si carga el cuadro de sedes o sale error...');

      // --- VALIDACIÓN: reacciona a lo que responda primero, sin esperas fijas ---
      const resultado = await esperarResultado(page, TIMEOUT_MAX_RESPUESTA);

      if (resultado === 'cuadro') {
        console.log('🚨 ¡HAY CITAS DETECTADAS! Haciendo clic y tomando captura...');
        await page.locator('#control_204').click({ timeout: 5000 });
        await esperar(1000);

        const captura = await page.screenshot({ fullPage: true });

        await enviarCapturaTelegram(captura,
          '🚨 *¡HAY CITAS EN LA DIAN!*\n\n' +
          '• Trámite: *Devoluciones*\n' +
          '• ¡El cuadro de sedes se habilitó!\n\n' +
          `[Ingresar a agendar de inmediato](${DIAN_URL})`
        );

        console.log(`Cita reportada. Esperando intervalo (${INTERVAL / 1000}s)...`);
        await esperar(INTERVAL);
        // Tras reportar, recargamos la página limpia para volver a monitorear
        await page.goto(DIAN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        continue;
      }

      if (resultado === 'modal') {
        console.log('ℹ️ Sin citas. Haciendo clic en Aceptar para reiniciar el flujo...');

        const botonAceptar = page.getByRole('button', { name: /Aceptar/i });
        await botonAceptar.click({ timeout: 5000 }).catch(async () => {
          await page.locator('text=Aceptar').first().click({ timeout: 3000 });
        });

        await esperar(INTERVAL);
        continue;
      }

      // resultado === 'timeout': no apareció ni cuadro ni modal, la página se trabó
      throw new Error('La página no mostró citas ni mensaje de error (se quedó en blanco o congelada).');

    } catch (error) {
      console.warn(`⚠️ Caída detectada: ${error.message.split('\n')[0]}`);

      const segundosReintento = ESPERA_COLAPSO / 1000;

      try {
        const capturaFallo = await page.screenshot({ timeout: 5000 });
        await enviarCapturaTelegram(capturaFallo, `⚠️ *Alerta DIAN:* La página colapsó. Reiniciando en ${segundosReintento} segundos...`);
      } catch (e) {
        await enviarCapturaTelegram(null, `⚠️ *Alerta DIAN:* La página colapsó tan fuerte que no dejó tomar captura. Reiniciando en ${segundosReintento} segundos...`);
      }

      // En caso de colapso real, recargamos la URL completa para empezar de cero
      await esperar(ESPERA_COLAPSO);
      await page.goto(DIAN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }
  }
}

iniciarMonitor();