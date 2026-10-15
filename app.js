/* ============ CONFIG ============ */
const params = new URLSearchParams(location.search);
// tambahkan ?idletest=5000 di URL buat tes idle-reset dgn cepat (dlm ms)
const IDLE_MS = params.has('idletest') ? parseInt(params.get('idletest'), 10) : 60 * 60 * 1000;

/* ============ STATE ============ */
let allData = [];
let dataLoaded = false;
let dataError = null;
let lastQueryTokens = [];

/* ============ HELPERS ============ */
function tokenize(query){
  return String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
}

// Buang semua karakter selain huruf/angka & lowercase-kan. Dipakai supaya
// "DS-Pro100", "DSpro100", "DS Pro 100", "dspro-100" dianggap sama.
function normalizeLoose(s){
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Bangun regex yang mengizinkan spasi/strip/underscore/titik APAPUN di antara
// tiap karakter token (setelah token-nya sendiri dinormalisasi). Dipakai
// sebagai fallback kalau pencarian persis (includes) gagal, supaya variasi
// penulisan kode/nama part tetap ketemu.
function buildFuzzyRegex(token){
  const norm = normalizeLoose(token);
  if (!norm) return null;
  const pattern = norm.split('').map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\-_.]*');
  try { return new RegExp(pattern, 'i'); } catch (e) { return null; }
}

function itemMatchesTokens(item, tokens){
  if (tokens.length === 0) return true;
  const haystack = `${item.produk || ''} ${item.part || ''} ${item.kode || ''}`.toLowerCase();
  return tokens.every(t => {
    if (!t) return true;
    if (haystack.includes(t)) return true;
    const fuzzy = buildFuzzyRegex(t);
    return fuzzy ? fuzzy.test(haystack) : false;
  });
}
function highlightTokens(text, tokens){
  if (!text) return '';
  let result = escapeHtml(text);
  tokens.forEach(t => {
    if (!t) return;
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const plainRegex = new RegExp(`(${escaped})`, 'gi');
    if (plainRegex.test(result)) {
      result = result.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
      return;
    }
    const fuzzy = buildFuzzyRegex(t);
    if (fuzzy) {
      const fuzzyGlobal = new RegExp(fuzzy.source, 'gi');
      result = result.replace(fuzzyGlobal, '<mark>$&</mark>');
    }
  });
  return result;
}
function escapeHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeJs(s){
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
function formatRupiah(angka){
  if (angka === undefined || angka === null) return 'Rp 0';
  let number = typeof angka === 'string' ? parseFloat(angka) : angka;
  if (isNaN(number)) {
    const str = String(angka).replace(/[^\d.-]/g, '');
    number = parseFloat(str) || 0;
  }
  return 'Rp ' + number.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function hashCode(s){
  let h = 0;
  for (let i = 0; i < String(s).length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return h;
}
const PALETTE = ['#5170ff', '#ec465f', '#4d4d4d', '#8a8fb3', '#e07a3f'];
function initials(s){
  return String(s || '?').split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
}

/* ============ LOAD DATA DARI SERVER (Apps Script API) ============ */
const API_URL = 'https://script.google.com/macros/s/AKfycbxKnu5rQldB9OjgmS39LfoS9lvitv_xNaEUiD1BhLBCn6eJH3y1IHpsdUWey0RaIbS_yQ/exec';
const CACHE_KEY = 'sparepart_data_v1';

// GET sederhana tanpa custom header -> tidak kena preflight CORS
function callApi(params){
  const url = API_URL + '?' + new URLSearchParams(params).toString();
  return fetch(url, { method: 'GET', redirect: 'follow' }).then(res => {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  });
}

function readCache(){
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && Array.isArray(obj.data) ? obj.data : null;
  } catch (e) { return null; }
}
function writeCache(data){
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data })); }
  catch (e) { /* storage penuh/diblokir: abaikan */ }
}

function initData(data){
  if (data && data.error) {
    onLoadFailure({ message: data.error });
    return;
  }
  const baru = data || [];
  // data sama persis dengan yang sudah tampil -> tidak perlu render ulang
  if (dataLoaded && JSON.stringify(baru) === JSON.stringify(allData)) return;
  allData = baru;
  dataLoaded = true;
  dataError = null;
  console.log('Data loaded:', allData.length, 'items');
  if (document.body.classList.contains('app-active')) {
    const q = document.getElementById('heroInput').value.trim();
    if (q) runSearch(q); else showPromptState();
  }
}

function onLoadFailure(err){
  const pesan = err && err.message ? err.message : 'Gagal memuat data';
  if (dataLoaded) {
    // sudah ada data dari cache: tetap pakai, cukup kasih tahu
    console.warn('Refresh data gagal, memakai data tersimpan:', pesan);
    showToast('Tidak bisa memperbarui data, memakai data tersimpan', 'error');
    return;
  }
  dataError = pesan;
  console.error('Error:', dataError);
  if (document.body.classList.contains('app-active')) renderTable([]);
}

(function loadData(){
  const cached = readCache();
  if (cached) initData(cached);
  callApi({ action: 'data' })
    .then(function(data){
      if (!Array.isArray(data)) throw new Error(data && data.error ? data.error : 'Format data tidak valid');
      writeCache(data);
      initData(data);
    })
    .catch(onLoadFailure);
})();

/* ============ FILTER / SEARCH ============ */
function filterData(query){
  const tokens = tokenize(query);
  lastQueryTokens = tokens;
  if (tokens.length === 0) return allData.slice();
  return allData.filter(item => itemMatchesTokens(item, tokens));
}
function runSearch(query){
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    showPromptState();
    return [];
  }
  if (!dataLoaded) {
    renderLoadingRow();
    hideStats();
    return [];
  }
  const results = filterData(query).slice().sort((a, b) => (a.produk || '').localeCompare(b.produk || ''));
  renderTable(results);
  showStats(results.length);
  return results;
}

/* ============ STATS SHOW/HIDE ============ */
function showStats(count){
  const wrap = document.getElementById('statsWrap');
  document.getElementById('statsCount').textContent = count;
  wrap.style.display = 'flex';
  requestAnimationFrame(() => wrap.classList.add('show'));
}
function hideStats(){
  const wrap = document.getElementById('statsWrap');
  wrap.classList.remove('show');
  wrap.style.display = 'none';
}

/* ============ RENDER TABEL ============ */
function renderLoadingRow(){
  document.getElementById('tableBody').innerHTML =
    `<tr class="no-data-row"><td colspan="7"><span class="loading-spin"></span> Memuat data...</td></tr>`;
}
function showPromptState(){
  hideStats();
  document.getElementById('tableBody').innerHTML = `
    <tr class="no-data-row">
      <td colspan="7">
        <div class="empty-illust">
          <img src="https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExaDNkamczNzVydTljZHB1aHd0NmthaDFsdmZiM2dqcHMwbzlybDIwdCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/l0Iyc2Jb4Dqaidg1a/giphy.gif" alt="Mencari sparepart...">
          <p>Ketik untuk mencari sparepart, selalu lakukan double check</p>
        </div>
      </td>
    </tr>`;
}

function renderTable(items){
  const tbody = document.getElementById('tableBody');

  if (dataError) {
    tbody.innerHTML = `<tr class="no-data-row"><td colspan="7">Gagal memuat data: ${escapeHtml(dataError)}</td></tr>`;
    return;
  }
  if (items.length === 0) {
    tbody.innerHTML = `
      <tr class="no-data-row">
        <td colspan="7">
          <div class="empty-illust">
            <img src="https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExNTMxa3RteHRtaG84dTJya3FncXJxM2ttbW84aHI0aXl0MHY3cDFwayZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/Z6qxCMQ2lwFvdBHxoa/giphy.gif" alt="Tidak ditemukan">
            <p>Tidak ada sparepart ditemukan</p>
          </div>
        </td>
      </tr>`;
    return;
  }

  let html = '';
  let lastProduk = null;

  items.forEach(item => {
    if (item.produk !== lastProduk) {
      lastProduk = item.produk;
      html += `<tr class="group-row"><td colspan="7">${escapeHtml(item.produk || '-')}</td></tr>`;
    }

    const color = PALETTE[Math.abs(hashCode(item.produk || '')) % PALETTE.length];
    const kodeDisplay = item.kode && item.kode !== '-' ? item.kode : '-';
    const remarksHtml = item.remarks ? `<span class="remarks">${escapeHtml(item.remarks)}</span>` : '';

    const fotoHtml = item.gambarUrl
      ? `<img src="${item.gambarUrl}" class="foto-thumb" alt="${escapeHtml(item.part || 'produk')}" loading="lazy" onclick="showFotoPreview('${escapeJs(item.gambarUrl)}')">`
      : `<div class="thumb" style="background:${color}">${initials(item.produk)}</div>`;

    const tombolFoto = item.gambarUrl
      ? `<button class="btn btn-foto" onclick="copyFoto('${escapeJs(item.kode)}','${escapeJs(item.remarks)}', this)">Salin Foto</button>`
      : '';

    html += `
      <tr class="item-row">
        <td data-label="Foto">${fotoHtml}</td>
        <td data-label="Produk"><strong>${escapeHtml(item.produk || '-')}</strong></td>
        <td data-label="Kode"><span class="kode-badge">${escapeHtml(kodeDisplay)}</span>${remarksHtml}</td>
        <td data-label="Part">${escapeHtml(item.part || '-')}</td>
        <td data-label="Stok"><span class="stock-pill">${escapeHtml(item.stock || '0')}</span></td>
        <td data-label="Harga"><span class="harga">${formatRupiah(item.harga)}</span></td>
        <td data-label="Aksi" class="td-aksi">
          <div class="aksi">
            <button class="btn btn-data" onclick="copyData(this,'${escapeJs(item.kode)}','${escapeJs(item.part)}','${escapeJs(item.produk)}',${JSON.stringify(item.harga)})">Salin Data</button>
            ${tombolFoto}
          </div>
        </td>
      </tr>`;
  });

  tbody.innerHTML = html;
}

/* ============ SUGGESTIONS ============ */
function buildSuggestHtml(results, tokens){
  if (results.length === 0) return `<div class="suggest-item" style="text-align:center;color:#999;">Tidak ada hasil</div>`;

  // Dedupe per produk, pilih item representatif paling relevan sama query
  const byProduk = new Map();
  results.forEach(item => {
    const existing = byProduk.get(item.produk);
    if (!existing) { byProduk.set(item.produk, item); return; }
    const produkCocokPenuh = tokens.every(t => (item.produk || '').toLowerCase().includes(t));
    if (produkCocokPenuh) return;
    const existingCocok = tokens.some(t => (existing.part || '').toLowerCase().includes(t) || (existing.kode || '').toLowerCase().includes(t));
    const itemCocok = tokens.some(t => (item.part || '').toLowerCase().includes(t) || (item.kode || '').toLowerCase().includes(t));
    if (!existingCocok && itemCocok) byProduk.set(item.produk, item);
  });

  return Array.from(byProduk.values()).slice(0, 8).map(item => {
    const produkCocokLangsung = tokens.every(t => (item.produk || '').toLowerCase().includes(t));
    let note = '';
    if (!produkCocokLangsung && item.part) {
      note = `<span class="note">cocok pada part: ${highlightTokens(item.part, tokens)}</span>`;
    } else if (!produkCocokLangsung && item.kode) {
      note = `<span class="note">cocok pada kode: ${highlightTokens(item.kode, tokens)}</span>`;
    }
    return `<div class="suggest-item" onclick="selectSuggest('${escapeJs(item.produk)}')"><b>${highlightTokens(item.produk, tokens)}</b>${note}</div>`;
  }).join('');
}

window.selectSuggest = function(produk){
  document.getElementById('heroInput').value = produk;
  hideSuggest(heroSuggest);
  triggerFlip(heroIconBtn);
  searchByProduk(produk);
};

// Setelah pilih dari suggestion: filter ke produk itu, digabung dengan token
// yang sudah diketik (kalau tokennya cocok di part/kode, hasil ikut menyempit)
function searchByProduk(produk){
  const tokens = lastQueryTokens.length ? lastQueryTokens : tokenize(produk);
  const filtered = allData.filter(item => item.produk === produk && itemMatchesTokens(item, tokens));
  renderTable(filtered);
  showStats(filtered.length);
  return filtered;
}

function hideSuggest(box){ box.classList.remove('show'); }
function triggerFlip(btn){ btn.classList.add('flip'); setTimeout(() => btn.classList.remove('flip'), 500); }

/* ============ COPY ACTIONS ============ */
function showToast(message, type){
  const toast = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = message;
  const dot = document.getElementById('toastDot');
  dot.classList.toggle('error', type === 'error');
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 3000);
}

function copyData(btn, kode, part, produk, harga){
  const hargaFormatted = formatRupiah(harga);
  const textToCopy = `Detail sparepart:
> Sparepart : ${part || '-'}
> Kode: ${kode || '-'}
> Produk : ${produk || '-'}
> Harga : ${hargaFormatted}
Harga sudah PPN, belum disc`;

  navigator.clipboard.writeText(textToCopy).then(() => {
    showToast('Data berhasil disalin ke clipboard!');
    flashCopied(btn);
  }).catch(err => {
    console.error('Failed to copy:', err);
    showToast('Gagal menyalin data', 'error');
  });
}

function copyFoto(kode, remarks, btnEl){
  const originalText = btnEl.innerHTML;
  btnEl.innerHTML = 'Memuat...';
  btnEl.disabled = true;

  function reset(){
    btnEl.innerHTML = originalText;
    btnEl.disabled = false;
  }

  callApi({ action: 'gambar', kode: kode, remarks: remarks })
    .then(function(res){
      if (!res || res.error) {
        showToast(res && res.error ? res.error : 'Gagal mengambil gambar', 'error');
        reset();
        return;
      }
      try {
        const byteChars = atob(res.base64);
        const byteNumbers = new Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: res.mimeType });

        const img = new Image();
        img.onload = function(){
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext('2d').drawImage(img, 0, 0);
          canvas.toBlob(function(pngBlob){
            navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
              .then(() => {
                showToast('Foto berhasil disalin!');
                flashCopied(btnEl, originalText);
              })
              .catch((err) => {
                showToast('Browser tidak mendukung salin gambar: ' + err.message, 'error');
                reset();
              });
          }, 'image/png');
        };
        img.onerror = function(){
          showToast('Gagal memproses gambar', 'error');
          reset();
        };
        img.src = URL.createObjectURL(blob);
      } catch (e) {
        showToast('Gagal menyalin foto: ' + e.message, 'error');
        reset();
      }
    })
    .catch(function(){
      showToast('Gagal mengambil gambar dari server', 'error');
      reset();
    });
}

function flashCopied(btn, restoreText){
  const original = restoreText !== undefined ? restoreText : btn.innerHTML;
  btn.classList.add('copied');
  btn.disabled = false;
  btn.innerHTML = 'Tersalin';
  setTimeout(() => {
    btn.classList.remove('copied');
    btn.innerHTML = original;
  }, 1500);
}

/* ============ IMAGE PREVIEW (foto asli: zoom / rotate / flip) ============ */
const ZOOM_LEVELS = [1, 2, 4, 10];
let zoomIndex = 1;
let rotateAngle = 0;
let flipX = false;
let flipY = false;

const imgOverlay = document.getElementById('imgOverlay');
const imgOverlayImg = document.getElementById('imgOverlayImg');

function showFotoPreview(url){
  if (!url) return;
  const hiResUrl = url.replace(/sz=w\d+/, 'sz=w2000');
  zoomIndex = 1;
  rotateAngle = 0;
  flipX = false;
  flipY = false;
  document.getElementById('ovFlipH').classList.remove('active');
  document.getElementById('ovFlipV').classList.remove('active');
  imgOverlayImg.src = hiResUrl;
  applyZoom();
  imgOverlay.classList.add('show');
}
function closeImgPreview(){
  imgOverlay.classList.remove('show');
  zoomIndex = 1;
  rotateAngle = 0;
  flipX = false;
  flipY = false;
  document.getElementById('ovFlipH').classList.remove('active');
  document.getElementById('ovFlipV').classList.remove('active');
  applyZoom();
}
function applyZoom(){
  const level = ZOOM_LEVELS[zoomIndex];
  const scaleXVal = level * (flipX ? -1 : 1);
  const scaleYVal = level * (flipY ? -1 : 1);
  imgOverlayImg.style.transform = `rotate(${rotateAngle}deg) scale(${scaleXVal}, ${scaleYVal})`;
  document.getElementById('ovZoomLabel').textContent = level + 'x';
  document.getElementById('ovZoomOut').disabled = zoomIndex === 0;
  document.getElementById('ovZoomIn').disabled = zoomIndex === ZOOM_LEVELS.length - 1;
}

document.getElementById('imgOverlayClose').addEventListener('click', closeImgPreview);
imgOverlay.addEventListener('click', (e) => {
  if (e.target === imgOverlay && zoomIndex === 0) closeImgPreview();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && imgOverlay.classList.contains('show')) closeImgPreview();
});
document.getElementById('ovRotateLeft').addEventListener('click', (e) => { e.stopPropagation(); rotateAngle -= 90; applyZoom(); });
document.getElementById('ovRotateRight').addEventListener('click', (e) => { e.stopPropagation(); rotateAngle += 90; applyZoom(); });
document.getElementById('ovFlipH').addEventListener('click', function(e){ e.stopPropagation(); flipX = !flipX; this.classList.toggle('active', flipX); applyZoom(); });
document.getElementById('ovFlipV').addEventListener('click', function(e){ e.stopPropagation(); flipY = !flipY; this.classList.toggle('active', flipY); applyZoom(); });
document.getElementById('ovZoomIn').addEventListener('click', (e) => { e.stopPropagation(); if (zoomIndex < ZOOM_LEVELS.length - 1) { zoomIndex++; applyZoom(); } });
document.getElementById('ovZoomOut').addEventListener('click', (e) => { e.stopPropagation(); if (zoomIndex > 0) { zoomIndex--; applyZoom(); } });

/* ============ APP STATE: idle <-> active ============ */
const body = document.body;
const landing = document.getElementById('landing');
const heroShell = document.getElementById('heroShell');
const heroInput = document.getElementById('heroInput');
const heroIconBtn = document.getElementById('heroIconBtn');
const heroSuggest = document.getElementById('heroSuggest');
const tooltipBubble = document.getElementById('tooltipBubble');
const revealEls = document.querySelectorAll('.reveal');

function showTooltip(){ tooltipBubble.classList.add('show'); }
function hideTooltip(){ tooltipBubble.classList.remove('show'); }

function activateApp(){
  if (body.classList.contains('app-active')) return;
  hideTooltip();
  setTimeout(() => {
    body.classList.add('app-active');
    heroShell.classList.add('expanded');
  }, 220);
  setTimeout(() => { heroInput.focus(); }, 900);
  revealEls.forEach((el, i) => {
    setTimeout(() => {
      el.style.display = 'block';
      requestAnimationFrame(() => el.classList.add('show'));
    }, 650 + i * 160);
  });
  setTimeout(() => showPromptState(), 650);
}

function goIdle(){
  if (!body.classList.contains('app-active')) { showTooltip(); return; }
  hideStats();
  const reversed = Array.from(revealEls).reverse();
  reversed.forEach((el, i) => {
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { el.style.display = 'none'; }, 700);
    }, i * 120);
  });
  setTimeout(() => {
    body.classList.remove('app-active');
    heroShell.classList.remove('expanded');
    heroInput.value = '';
    hideSuggest(heroSuggest);
    floatSearch.classList.remove('visible');
    floatShell.classList.remove('open');
    floatInput.value = '';
    hideSuggest(floatSuggest);
  }, 400);
  setTimeout(showTooltip, 1500);
}

setTimeout(showTooltip, 500);

heroShell.addEventListener('click', () => {
  if (!body.classList.contains('app-active')) activateApp();
});

/* ============ HERO SEARCH interactions ============ */
let heroDebounce;
heroInput.addEventListener('input', (e) => {
  clearTimeout(heroDebounce);
  const q = e.target.value.trim();
  if (q.length === 0) { hideSuggest(heroSuggest); runSearch(''); return; }
  heroDebounce = setTimeout(() => {
    if (!dataLoaded) return;
    const tokens = tokenize(q);
    const results = allData.filter(item => itemMatchesTokens(item, tokens));
    heroSuggest.innerHTML = buildSuggestHtml(results, tokens);
    heroSuggest.classList.add('show');
    triggerFlip(heroIconBtn);
    runSearch(q);
  }, 400);
});
heroInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(heroDebounce);
    hideSuggest(heroSuggest);
    triggerFlip(heroIconBtn);
    runSearch(e.target.value.trim());
  }
});
heroIconBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!body.classList.contains('app-active')) { activateApp(); return; }
  triggerFlip(heroIconBtn);
  runSearch(heroInput.value.trim());
  hideSuggest(heroSuggest);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-shell')) hideSuggest(heroSuggest);
});

/* ============ FLOATING FAB (only while active) ============ */
const floatSearch = document.getElementById('floatSearch');
const floatShell = document.getElementById('floatShell');
const floatInput = document.getElementById('floatInput');
const floatIconBtn = document.getElementById('floatIconBtn');
const floatSuggest = document.getElementById('floatSuggest');
const floatHint = document.getElementById('floatHint');

const io = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!body.classList.contains('app-active')) return;
    if (entry.isIntersecting) {
      floatSearch.classList.remove('visible');
      floatShell.classList.remove('open');
      floatInput.value = '';
      hideSuggest(floatSuggest);
    } else {
      floatSearch.classList.add('visible');
    }
  });
}, { threshold: 0 });
io.observe(landing);

floatShell.addEventListener('click', () => {
  if (floatShell.classList.contains('open')) return;
  floatShell.classList.add('open');
  setTimeout(() => floatInput.focus(), 200);
});
floatIconBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!floatShell.classList.contains('open')) {
    floatShell.classList.add('open');
    setTimeout(() => floatInput.focus(), 200);
    return;
  }
  triggerFlip(floatIconBtn);
  const results = runSearch(floatInput.value.trim());
  showFloatHint(results.length);
});
let floatDebounce;
floatInput.addEventListener('input', (e) => {
  clearTimeout(floatDebounce);
  const q = e.target.value.trim();
  heroInput.value = q; // sinkron dengan hero input
  if (q.length === 0) { hideSuggest(floatSuggest); floatHint.classList.remove('show'); runSearch(''); return; }
  floatDebounce = setTimeout(() => {
    if (!dataLoaded) return;
    const tokens = tokenize(q);
    const results = allData.filter(item => itemMatchesTokens(item, tokens));
    floatSuggest.innerHTML = buildSuggestHtml(results, tokens);
    floatSuggest.classList.add('show');
    triggerFlip(floatIconBtn);
    const searched = runSearch(q);
    showFloatHint(searched.length);
  }, 400);
});
floatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(floatDebounce);
    hideSuggest(floatSuggest);
    triggerFlip(floatIconBtn);
    const results = runSearch(e.target.value.trim());
    showFloatHint(results.length);
  }
});
function showFloatHint(count){
  floatHint.innerHTML = `${count} hasil ditemukan <a onclick="scrollToTable()">lihat ↓</a>`;
  floatHint.classList.add('show');
  clearTimeout(showFloatHint._t);
  showFloatHint._t = setTimeout(() => floatHint.classList.remove('show'), 4000);
}
window.scrollToTable = function(){ document.getElementById('cardWrap').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
document.addEventListener('click', (e) => {
  if (!e.target.closest('.float-search') && floatShell.classList.contains('open')) {
    floatShell.classList.remove('open');
    hideSuggest(floatSuggest);
  }
});

/* ============ IDLE TIMER (auto revert setelah tanpa aktivitas) ============ */
let idleTimer;
function resetIdleTimer(){
  clearTimeout(idleTimer);
  idleTimer = setTimeout(goIdle, IDLE_MS);
}
['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(evt => {
  document.addEventListener(evt, resetIdleTimer, { passive: true });
});
resetIdleTimer();

/* ============ PWA: SERVICE WORKER ============ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW gagal didaftarkan:', err));
  });
}
