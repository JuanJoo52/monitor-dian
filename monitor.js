require('dotenv').config();
const { chromium } = require('playwright');
const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8675429592:AAHdFWw2z95vVM4HnsnhLOSRLUWx6Y_8IL4';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '2061324025';
const INTERVAL = (parseInt(process.env.CHECK_INTERVAL_SECONDS, 10) || 45) * 1000;
const DIAN_URL = 'https://agendamiento.dian.gov.co/';

async function sendTelegramAlert(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
    console.log('✅ Alerta enviada a Telegram.');
  } catch (err) {
    console.error('❌ Error enviando a Telegram:', err.message);
  }
}

async function checkDian() {
  const timestamp = new Date().toLocaleTimeString('es-CO');
  console.log(`\n[${timestamp}] Consultando disponibilidad en la DIAN...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);

  try {
    await page.goto(DIAN_URL, { waitUntil: 'domcontentloaded' });

    // 1. Seleccionar Persona Natural
    await page.locator('#control_209').click();
    await page.locator('div').filter({ hasText: /^PersonaNatural$/ }).first().click();

    // 2. Seleccionar Video Atención
    await page.locator('div:nth-child(2) > .contentImgTipoAtencion > .img-fluid').click();

    // 3. Seleccionar Devoluciones
    await page.locator('div').filter({ hasText: /^Devoluciones\.$/ }).first().click();

    // 4. Esperar la respuesta:
    // Definimos el aviso modal que viste en tu foto
    const modalSinCitas = page.getByText('No se encontraron especialidades relacionadas según los filtros seleccionados');
    const botonAceptarModal = page.getByRole('button', { name: 'Aceptar' });

    // Le damos hasta 12 segundos a la DIAN para que responda tras el clic
    let hayModal = false;
    try {
      await modalSinCitas.waitFor({ state: 'visible', timeout: 12000 });
      hayModal = true;
    } catch {
      hayModal = false;
    }

    if (hayModal) {
      console.log('ℹ️ Sin citas disponibles (detectado modal de advertencia).');
    } else {
      // Si pasaron 12s y la ventana modal NO apareció, revisamos si sacó el botón Aceptar de todas formas
      const botonVisible = await botonAceptarModal.isVisible().catch(() => false);

      if (botonVisible) {
        console.log('ℹ️ Sin citas disponibles (botón Aceptar del modal detectado).');
      } else {
        // No hay modal ni botón de advertencia: ¡SE HABILITÓ LA SEDE!
        console.log('🚨 ¡HAY CITAS DETECTADAS! Notificando a Telegram...');
        await sendTelegramAlert(
          '🚨 *¡HAY CITAS EN LA DIAN!*\n\n' +
          '• Modalidad: *Video Atención*\n' +
          '• Trámite: *Devoluciones*\n' +
          '• Estado: No apareció el bloqueo de error, el portal habilitó sedes.\n\n' +
          `[Ingresar a agendar de inmediato](${DIAN_URL})`
        );
      }
    }

  } catch (error) {
    console.warn(`⚠️ Error de red o página congelada: ${error.message}`);
  } finally {
    await browser.close();
  }
}

async function run() {
  await checkDian();
  setInterval(checkDian, INTERVAL);
}

run();