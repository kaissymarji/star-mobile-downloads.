(() => {
  'use strict';
  const byId = id => document.getElementById('vin-' + id);
  const panel = byId('panel'), toggle = byId('toggle'), input = byId('input');
  const camera = byId('camera'), video = byId('video'), file = byId('file');
  const status = byId('status'), result = byId('result'), links = byId('links');
  let generation = 0, stream = null, timer = null, request = null;
  let cameraActive = false, readerPromise = null;

  function stop() {
    generation++;
    clearTimeout(timer);
    if (request) request.abort();
    request = null;
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    video.hidden = true;
    cameraActive = false;
    camera.textContent = 'Start camera';
  }

  function begin(message) {
    stop();
    result.hidden = true;
    links.replaceChildren();
    input.removeAttribute('aria-invalid');
    status.textContent = message;
    return generation;
  }

  function portal(label, href) {
    const link = document.createElement('a');
    link.textContent = label;
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    links.append(link);
  }

  const validVIN = /^[A-HJ-NPR-Z0-9]{17}$/;
  function barcodeVIN(raw) {
    const value = raw.trim().toUpperCase().replace(/^VIN\s*[:=]?\s*/, '');
    if (validVIN.test(value)) return value;
    // Some vehicle labels prefix the VIN with the data identifier I.
    if (value.startsWith('I') && validVIN.test(value.slice(1))) return value.slice(1);
    return '';
  }

  function displayVehicle(row) {
    const make = normalize(row.Make || '');
    const brand = manufacturers.find(item => normalize(item.name) === make);
    const entry = brand && brand.name === 'Mercedes-Benz' && /\bsprinter\b/i.test(row.Model || '')
      ? manufacturers.find(item => item.name === 'Mercedes-Benz Sprinter') || brand : brand;
    const name = [row.ModelYear, brand ? brand.name : row.Make, row.Model].filter(Boolean).join(' ');
    byId('vehicle').textContent = name;
    const liters = Number(row.DisplacementL);
    const engine = [liters > 0 && liters.toFixed(1) + ' L', row.EngineCylinders && row.EngineCylinders + '-cyl'].filter(Boolean).join(' ');
    byId('details').textContent = [row.Trim, engine, row.FuelTypePrimary].filter(Boolean).join(' · ');
    if (entry) {
      portal(entry.name + ' OEM Service', entry.service);
      if (entry.key) portal(entry.name + ' Key Codes', entry.key[0]);
    }
    const warnings = (row.ErrorCode || '').split(',').map(code => code.trim()).filter(code => code && code !== '0');
    const messages = [];
    if (warnings.length) messages.push('Check the VIN. ' + (row.ErrorText || 'NHTSA returned a partial decode.'));
    if (!entry) messages.push('No matching portal in this directory.');
    status.textContent = messages.join(' ');
    result.hidden = false;
  }

  async function decode() {
    const id = begin('');
    const vin = input.value.trim().toUpperCase().replace(/\s+/g, '');
    input.value = vin;
    if (!validVIN.test(vin)) {
      input.setAttribute('aria-invalid', 'true');
      status.textContent = 'Enter all 17 letters and numbers. A VIN cannot contain I, O, or Q.';
      input.focus();
      return;
    }
    status.textContent = 'Looking up vehicle…';
    const controller = new AbortController();
    request = controller;
    const deadline = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/' + vin + '?format=json', {
        signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer'
      });
      if (!response.ok) throw new Error('Lookup unavailable');
      const data = await response.json();
      if (id !== generation) return;
      const row = data.Results && data.Results[0];
      if (!row || (!row.Make && !row.Model)) {
        status.textContent = 'NHTSA could not identify this vehicle. Recheck the VIN or search by manufacturer below.';
        return;
      }
      displayVehicle(row);
    } catch {
      if (id !== generation) return;
      status.textContent = 'Could not reach NHTSA. Check your connection and tap Decode to retry.';
      byId('vehicle').textContent = '';
      byId('details').textContent = '';
      portal('Open NHTSA VIN decoder', 'https://vpic.nhtsa.dot.gov/decoder/VinDecoder?VIN=' + vin);
      result.hidden = false;
    } finally {
      clearTimeout(deadline);
      if (request === controller) request = null;
    }
  }

  function loadReader() {
    if (readerPromise) return readerPromise;
    readerPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './vendor/zxing-0.21.3.min.js';
      script.onload = () => {
        try {
          const z = window.ZXing;
          const reader = new z.MultiFormatReader();
          const formats = [z.BarcodeFormat.CODE_39, z.BarcodeFormat.CODE_128, z.BarcodeFormat.QR_CODE, z.BarcodeFormat.DATA_MATRIX];
          reader.setHints(new Map([[z.DecodeHintType.POSSIBLE_FORMATS, formats], [z.DecodeHintType.TRY_HARDER, true]]));
          resolve(reader);
        } catch (error) { reject(error); }
      };
      script.onerror = () => reject(new Error('Scanner unavailable'));
      document.head.append(script);
    }).catch(error => {
      readerPromise = null;
      throw error;
    });
    return readerPromise;
  }

  const canvas = document.createElement('canvas');
  function readBarcode(reader, source, width, height, limit) {
    const scale = Math.min(1, limit / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const z = window.ZXing;
    // Door labels can mount a linear barcode vertically.
    for (const rotated of [false, true]) {
      canvas.width = rotated ? h : w;
      canvas.height = rotated ? w : h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (rotated) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
      ctx.drawImage(source, 0, 0, w, h);
      const gray = z.HTMLCanvasElementLuminanceSource.makeBufferFromCanvasImageData(canvas, false);
      const pixels = new z.RGBLuminanceSource(gray, canvas.width, canvas.height);
      try {
        const decoded = reader.decodeWithState(new z.BinaryBitmap(new z.HybridBinarizer(pixels)));
        const vin = barcodeVIN(decoded.getText());
        if (vin) return vin;
      } catch (error) {
        if (!(error instanceof z.NotFoundException)) throw error;
      }
    }
    return '';
  }

  function acceptScan(vin) {
    input.value = vin;
    decode();
  }

  async function startCamera() {
    if (cameraActive) { begin('Camera stopped.'); return; }
    const id = begin('Opening camera…');
    cameraActive = true;
    camera.textContent = 'Stop camera';
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Camera unavailable');
      const reader = await loadReader();
      if (id !== generation) return;
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }
      }});
      if (id !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      video.srcObject = stream;
      video.hidden = false;
      await video.play();
      if (id !== generation) return;
      status.textContent = 'Hold the entire VIN barcode in view.';
      function scanFrame() {
        if (id !== generation) return;
        try {
          if (video.readyState >= 2 && video.videoWidth) {
            const vin = readBarcode(reader, video, video.videoWidth, video.videoHeight, 1280);
            if (vin) { acceptScan(vin); return; }
          }
        } catch { begin('Camera scan failed. Choose a barcode photo or enter the VIN.'); return; }
        timer = setTimeout(scanFrame, 300);
      }
      scanFrame();
    } catch (error) {
      if (id !== generation) return;
      begin(error.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access, choose a photo, or enter the VIN.'
        : 'Camera unavailable. Choose a barcode photo, enter the VIN, or open this page in Safari or Chrome.');
    }
  }

  async function scanPhoto(photo) {
    const id = begin('Reading barcode photo…');
    const url = URL.createObjectURL(photo);
    try {
      const image = new Image();
      const ready = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
      image.src = url;
      const [reader] = await Promise.all([loadReader(), ready]);
      if (id !== generation) return;
      const vin = readBarcode(reader, image, image.naturalWidth, image.naturalHeight, 2200);
      if (vin) acceptScan(vin);
      else status.textContent = 'No VIN barcode found. Try a sharp, close-up photo of the door-label barcode or enter the VIN.';
    } catch {
      if (id === generation) status.textContent = 'Could not read this photo. Try a JPG or PNG of the VIN barcode, or enter the VIN.';
    } finally { URL.revokeObjectURL(url); }
  }

  toggle.onclick = () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (panel.hidden) { stop(); if (result.hidden) status.textContent = ''; }
  };
  camera.onclick = startCamera;
  byId('photo').onclick = () => { begin(''); file.click(); };
  file.onchange = () => {
    const photo = file.files[0];
    file.value = '';
    if (photo) scanPhoto(photo);
  };
  input.oninput = () => begin('');
  byId('form').onsubmit = event => { event.preventDefault(); decode(); };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && cameraActive) begin('Camera paused. Tap Start camera to resume.');
  });
  window.addEventListener('pagehide', stop);
})();
