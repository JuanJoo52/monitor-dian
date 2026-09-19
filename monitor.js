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
      // Hacemos la petición
      await fetch(url, { method: 'POST', body: formData });
      
      // Si llega a esta línea, el envío fue un éxito. Rompemos el ciclo para no repetir.
      break; 
    } catch (err) {
      console.error(`❌ Fallo al enviar a Telegram (Intento ${intento}/${maxIntentos}):`, err.message);
      
      if (intento < maxIntentos) {
        // Esperamos 3 segundos antes del próximo intento
        await esperar(3000); 
      } else {
        console.error('❌ Se agotaron los intentos de Telegram. El mensaje no se pudo enviar.');
      }
    }
  }
}

async function iniciarMonitor() {
  console.log('🚀 Iniciando monitor robusto de la DIAN...');
  
  // 1. Abrimos el navegador UNA SOLA VEZ para proteger la memoria del servidor
  const browser = await chromium.launch({ headless: true });

  // 2. Ciclo infinito seguro
  while (true) {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport : { width: 1920, height: 1080}
    });
    const page = await context.newPage();

    try {
      console.log(`\n[${new Date().toLocaleTimeString('es-CO')}] Consultando disponibilidad...`);
      
      await page.goto(DIAN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // --- TUS PASOS DE NAVEGACIÓN ---
      await page.locator('#control_209').click({ timeout: 15000 });
      await page.locator('div').filter({ hasText: /^PersonaNatural$/ }).first().click();
      await page.locator('div:nth-child(2) > .contentImgTipoAtencion > .img-fluid').click();
      await page.locator('div').filter({ hasText: /^Devoluciones\.$/ }).first().click();

      console.log('Evaluando si carga el cuadro de sedes o sale error...');

      // --- VALIDACIÓN ESTRICTA ---
      // Le damos 15 segundos a la página para que decida qué mostrar
      const cuadroVisible = await page.locator('#control_204').waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);

      if (cuadroVisible) {
        // ÉXITO ABSOLUTO: Apareció el recuadro blanco
        console.log('🚨 ¡HAY CITAS DETECTADAS! Tomando captura...');
        await esperar(1000);
        const captura = await page.screenshot({ fullPage: true });
        
        await enviarCapturaTelegram(captura, 
          '🚨 *¡HAY CITAS EN LA DIAN!*\n\n' +
          '• Trámite: *Devoluciones*\n' +
          '• ¡El cuadro de sedes se habilitó!\n\n' +
          `[Ingresar a agendar de inmediato](${DIAN_URL})`
        );
        
        await page.close();
        await context.close();
        console.log(`Cita reportada. Esperando el intervalo normal (${INTERVAL / 1000}s) para seguir consultando...`);
        await esperar(INTERVAL); // Usa el mismo tiempo normal de espera que tienes en tu .env
        continue;
      } 
      
      // Si no salió el cuadro, verificamos si es que salió tu modal de "No hay citas"
      const modalSinCitas = page.getByText('No se encontraron especialidades');
      const hayModal = await modalSinCitas.isVisible();

      if (hayModal) {
        console.log('ℹ️ Sin citas (salió el modal normal).');
        await page.close();
        await context.close();
        await esperar(INTERVAL);
        continue;
      }

      // Si no salió ni el cuadro de éxito ni el modal de error... la página colapsó
      throw new Error('La página no mostró citas ni mensaje de error (se quedó en blanco o congelada).');

    } catch (error) {
      console.warn(`⚠️ Caída detectada: ${error.message.split('\n')[0]}`);
      
      try {
        const capturaFallo = await page.screenshot({ timeout: 5000 });
        await enviarCapturaTelegram(capturaFallo, '⚠️ *Alerta DIAN:* La página colapsó. Reiniciando en 2 minutos...');
      } catch (e) {
        // Si ni siquiera deja tomar foto, enviamos solo texto
        await enviarCapturaTelegram(null, '⚠️ *Alerta DIAN:* La página colapsó tan fuerte que no dejó tomar captura. Reiniciando en 2 minutos...');
      }

      await page.close().catch(() => {});
      await context.close().catch(() => {});
      await esperar(ESPERA_COLAPSO);
    }
  }
}

// Arrancar
iniciarMonitor();