require('dotenv').config();
const { chromium } = require('playwright');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INTERVAL = (parseInt(process.env.CHECK_INTERVAL_SECONDS, 10) || 45) * 1000;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error('❌ ERROR CRÍTICO: Faltan credenciales de Telegram.');
  process.exit(1);
}

const DIAN_URL = 'https://agendamiento.dian.gov.co/';
const ESPERA_COLAPSO = 10000;

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

      // Pausa técnica para permitir el despacho de la consulta
      await esperar(1500);

      console.log('Evaluando si carga el cuadro de sedes o sale error...');

      // --- VALIDACIÓN DE CITAS ---
      const cuadroVisible = await page.locator('#control_204')
        .waitFor({ state: 'visible', timeout: 15000 })
        .then(() => true)
        .catch(() => false);

      if (cuadroVisible) {
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

      // --- VALIDACIÓN DEL MODAL SIN CITAS ---
      const modalSinCitas = page.getByText('No se encontraron especialidades');
      const hayModal = await modalSinCitas.isVisible();

      if (hayModal) {
        console.log('ℹ️ Sin citas. Haciendo clic en Aceptar para reiniciar el flujo...');

        // Hacemos clic en el botón "Aceptar" del modal
        const botonAceptar = page.getByRole('button', { name: /Aceptar/i });
        await botonAceptar.click({ timeout: 5000 }).catch(async () => {
          // Si no lo encuentra por rol de botón, clic por texto general
          await page.locator('text=Aceptar').first().click({ timeout: 3000 });
        });

        // Esperamos el intervalo normal con la página ya lista
        await esperar(INTERVAL);
        continue;
      }

      // Si no hay cuadro ni modal, la página se trabó
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
