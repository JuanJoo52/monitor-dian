require('dotenv').config();
const { chromium } = require('playwright');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INTERVAL = (parseInt(process.env.CHECK_INTERVAL_SECONDS, 10) || 45) * 1000;

// Validación de seguridad de arranque
if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error('❌ ERROR CRÍTICO: Faltan credenciales de Telegram.');
  console.error('Asegúrate de que el archivo .env existe y contiene TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID.');
  process.exit(1); // Detiene la ejecución inmediatamente para no correr en vano
}

const DIAN_URL = 'https://agendamiento.dian.gov.co/';
const ESPERA_COLAPSO = 20000;
const TIMEOUT_CUADRO_SEDES = 25000; // antes 15000: evita falsos "colapso" cuando la DIAN está lenta
const CICLOS_ANTES_DE_RECICLAR = 100; // cierra y reabre el browser cada N chequeos

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Función centralizada para enviar mensaje + captura a Telegram (Con auto-reintentos)
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

  // Bucle de reintentos
  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      await fetch(url, { method: 'POST', body: formData });
      break; // éxito, no repetimos
    } catch (err) {
      console.error(`❌ Fallo al enviar a Telegram (Intento ${intento}/${maxIntentos}):`, err.message);
      if (intento < maxIntentos) {
        await esperar(3000);
      } else {
        console.error('❌ Se agotaron los intentos de Telegram. El mensaje no se pudo enviar.');
      }
    }
  }
}

async function iniciarMonitor() {
  console.log('🚀 Iniciando monitor robusto de la DIAN...');

  // Browser persistente (se usa `let` porque se recicla periódicamente)
  let browser = await chromium.launch({ headless: true });
  let ciclos = 0;

  while (true) {
    ciclos++;

    // Reciclaje periódico del browser para evitar memory creep en corridas largas
    if (ciclos > 1 && ciclos % CICLOS_ANTES_DE_RECICLAR === 0) {
      console.log(`♻️ Reciclando navegador tras ${CICLOS_ANTES_DE_RECICLAR} ciclos...`);
      await browser.close().catch(() => {});
      browser = await chromium.launch({ headless: true });
    }

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 }
    });
    const page = await context.newPage();

    try {
      console.log(`\n[${new Date().toLocaleTimeString('es-CO')}] Consultando disponibilidad... (ciclo ${ciclos})`);

      await page.goto(DIAN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // --- PASOS DE NAVEGACIÓN ---
      await page.locator('#control_209').click({ timeout: 15000 });
      await page.locator('div').filter({ hasText: /^PersonaNatural$/ }).first().click();
      await page.locator('div:nth-child(2) > .contentImgTipoAtencion > .img-fluid').click();
      await page.locator('div').filter({ hasText: /^Devoluciones\.$/ }).first().click();

      console.log('Evaluando si carga el cuadro de sedes o sale error...');

      // --- VALIDACIÓN ESTRICTA (reacciona a lo que aparezca primero) ---
      // En vez de esperar primero por #control_204 y recién después revisar el modal
      // (lo que obligaba a esperar el timeout completo cuando salía el modal),
      // hacemos polling corto comprobando ambos selectores cada 300ms.
      const cuadroLocator = page.locator('#control_204');
      const modalSinCitasLocator = page.getByText('No se encontraron especialidades');

      const POLL_MS = 300;
      const inicioEspera = Date.now();
      let cuadroVisible = false;
      let hayModal = false;

      while (Date.now() - inicioEspera < TIMEOUT_CUADRO_SEDES) {
        cuadroVisible = await cuadroLocator.isVisible().catch(() => false);
        if (cuadroVisible) break;

        hayModal = await modalSinCitasLocator.isVisible().catch(() => false);
        if (hayModal) break;

        await esperar(POLL_MS);
      }

      if (cuadroVisible) {
        // ÉXITO ABSOLUTO: Apareció el recuadro blanco
        console.log('🚨 ¡HAY CITAS DETECTADAS! Dando clic y tomando captura...');

        await page.locator('#control_204').click({ timeout: 5000 });
        await esperar(1000);

        const captura = await page.screenshot({ fullPage: true }).catch(() => null);

        await page.close().catch(() => {});
        await context.close().catch(() => {});

        await enviarCapturaTelegram(captura,
          '🚨 *¡HAY CITAS EN LA DIAN!*\n\n' +
          '• Trámite: *Devoluciones*\n' +
          '• ¡El cuadro de sedes se habilitó!\n\n' +
          `[Ingresar a agendar de inmediato](${DIAN_URL})`
        );

        console.log(`Cita reportada. Esperando el intervalo normal (${INTERVAL / 1000}s) para seguir consultando...`);
        await esperar(INTERVAL);
        continue;
      }

      // Si no salió el cuadro, ya sabemos (por la carrera de arriba) si salió el modal de "No hay citas"
      await page.close().catch(() => {});
      await context.close().catch(() => {});

      if (hayModal) {
        console.log('ℹ️ Sin citas (salió el modal normal).');
        await esperar(INTERVAL);
        continue;
      }

      // Si no salió ni el cuadro de éxito ni el modal de error... la página colapsó
      throw new Error('La página no mostró citas ni mensaje de error (se quedó en blanco o congelada).');

    } catch (error) {
      console.warn(`⚠️ Caída detectada: ${error.message.split('\n')[0]}`);

      let capturaFallo = null;
      try {
        capturaFallo = await page.screenshot({ timeout: 5000 });
      } catch (e) {
        capturaFallo = null;
      }

      // Cerramos page/context antes de enviar a Telegram, así no quedan colgados
      // mientras esperamos los reintentos de red.
      await page.close().catch(() => {});
      await context.close().catch(() => {});

      if (capturaFallo) {
        await enviarCapturaTelegram(capturaFallo, '⚠️ *Alerta DIAN:* La página colapsó. Reiniciando en 2 minutos...');
      } else {
        await enviarCapturaTelegram(null, '⚠️ *Alerta DIAN:* La página colapsó tan fuerte que no dejó tomar captura. Reiniciando...');
      }

      await esperar(ESPERA_COLAPSO);
    }
  }
}

// Arrancar
iniciarMonitor();