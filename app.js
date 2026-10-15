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
