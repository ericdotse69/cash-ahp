// --- 1. AES-256 ENCRYPTION CORE ---
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const buf = h => new Uint8Array(h.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

const CRYPTO_CORE = {
    async derive(pin) {
        let salt = localStorage.getItem('cp_v20_salt') || hex(crypto.getRandomValues(new Uint8Array(16)));
        localStorage.setItem('cp_v20_salt', salt);
        const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: buf(salt), iterations: 100000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    },
    async lock(data, pin) {
        const key = await this.derive(pin); const iv = crypto.getRandomValues(new Uint8Array(12));
        const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data)));
        return { iv: hex(iv), data: hex(enc) };
    },
    async unlock(obj, pin) {
        try {
            const key = await this.derive(pin);
            const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(obj.iv) }, key, buf(obj.data));
            return JSON.parse(new TextDecoder().decode(dec));
        } catch(e) { return null; }
    }
};

// --- 2. APPLICATION STATE ---
let transactions = []; let sessionPin = "";
const isNewSetup = !localStorage.getItem('cp_v20_hash');
// Wait for DOM to load before manipulating elements
document.addEventListener("DOMContentLoaded", () => {
    if(isNewSetup) { document.getElementById('sec-title').innerText = "DEVICE SETUP"; document.getElementById('sec-title').style.color = "var(--primary)"; }
    refreshTime();
});

// --- 3. SECURITY FLOW ---
async function initUnlock() {
    const pinField = document.getElementById('pin-field');
    const pin = pinField.value;
    const err = document.getElementById('sec-err');
    
    if(!pin || pin.length !== 4) return;

    if(isNewSetup) {
        localStorage.setItem('cp_v20_hash', hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin))));
        sessionPin = pin; finalizeUnlock();
    } else {
        const stored = localStorage.getItem('cp_v20_vault');
        if(!stored) { sessionPin = pin; finalizeUnlock(); return; }
        const dec = await CRYPTO_CORE.unlock(JSON.parse(stored), pin);
        if(dec) { sessionPin = pin; transactions = dec; finalizeUnlock(); }
        else { pinField.value = ""; err.style.display = "block"; }
    }
}

function finalizeUnlock() { document.getElementById('security-screen').style.display = 'none'; syncUI(); }

// --- 4. MOMO PASTE ASSISTANT ---
async function runPasteAI() {
    const sms = prompt("PASTE MOBILE MONEY ALERT:");
    if(!sms) return;

    const amtMatch = sms.match(/(?:GHS|GHC|AMT:)\s?([0-9,]+\.[0-9]{2})/i);
    const amount = amtMatch ? parseFloat(amtMatch[1].replace(',', '')) : 0;
    const refMatch = sms.match(/Reference:\s?([^.]+)/i);
    const autoRef = refMatch ? refMatch[1].trim() : "MOMO TRANSFER";
    const isIncome = (sms.toLowerCase().includes("received") || sms.toLowerCase().includes("cash-in") || sms.toLowerCase().includes("deposit"));

    if(amount > 0) {
        const userRef = prompt(`DETECTED: GHS ${amount}\nREFERENCE: "${autoRef}"\n\nEnter new reference or hit OK to save:`, autoRef);
        transactions.push({
            id: crypto.randomUUID(),
            text: "MOMO: " + (userRef || autoRef).toUpperCase(),
            amount: isIncome ? amount : -Math.abs(amount),
            category: "General",
            date: new Date().toISOString().slice(0, 16)
        });
        syncUI();
    } else { alert("LOGIC ERROR: NO AMOUNT DETECTED."); }
}

// --- 5. LIVE SCANNER & VOICE AI ---
let stream = null;
async function runScannerAI() {
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        document.getElementById('viewfinder').srcObject = stream;
        document.getElementById('scanner-container').style.display = 'flex';
    } catch (e) { alert("Camera Permission Required."); }
}
function stopScanner() { if(stream) stream.getTracks().forEach(t => t.stop()); document.getElementById('scanner-container').style.display = 'none'; }

async function processCapture() {
    const vid = document.getElementById('viewfinder');
    const can = document.createElement('canvas');
    can.width = vid.videoWidth; can.height = vid.videoHeight;
    can.getContext('2d').drawImage(vid, 0, 0);
    document.getElementById('ocr-status').innerText = "AI SCANNING...";
    const { data: { text } } = await Tesseract.recognize(can.toDataURL('image/jpeg'), 'eng');
    text.split('\n').forEach(line => {
        const m = line.match(/(\d+[\.,]\d{2})|(\d{2,5})/);
        if(m) {
            transactions.push({ id: crypto.randomUUID(), text: "SCAN: " + line.substring(0,10), amount: -Math.abs(parseFloat(m[0].replace(',','.'))), category: "General", date: new Date().toISOString().split('T')[0] });
        }
    });
    stopScanner(); syncUI();
}

function runVoiceAI() {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!Rec) return alert("Voice unsupported.");
    const rec = new Rec(); const btn = document.getElementById('voice-btn');
    btn.classList.add('active');
    rec.onresult = (e) => {
        const t = e.results[0][0].transcript.toLowerCase();
        const v = t.match(/\d+/);
        if(v) document.getElementById('inp-amt').value = v[0];
        document.getElementById('inp-text').value = t.replace(v, '').trim().toUpperCase();
        btn.classList.remove('active');
    };
    rec.start();
}

// --- 6. UI RENDER ENGINE (STATS RESTORED) ---
function syncUI() {
    const list = document.getElementById('tx-list'); list.innerHTML = '';
    const barTarget = document.getElementById('category-bars'); barTarget.innerHTML = '';
    let bal = 0, inc = 0, exp = 0; const catMap = {};

    transactions.sort((a,b) => new Date(b.date) - new Date(a.date)).forEach(t => {
        const v = parseFloat(t.amount); bal += v;
        if(v > 0) inc += v; 
        else { exp += Math.abs(v); catMap[t.category] = (catMap[t.category] || 0) + Math.abs(v); }
        
        const li = document.createElement('li');
        li.innerHTML = `<div><span style="font-size:0.5rem;display:block;color:#94a3b8">${t.date.split('T')[0]}</span><strong>${t.text}</strong></div>
                        <span style="color:${v > 0 ? 'var(--income)' : 'var(--expense)'}">${v.toFixed(2)}</span>`;
        list.appendChild(li);
    });

    Object.keys(catMap).forEach(c => {
        const p = (catMap[c] / exp) * 100;
        barTarget.innerHTML += `<div class="stat-row"><div class="stat-label"><span>${c}</span><span>${p.toFixed(0)}%</span></div><div class="stat-bar-bg"><div class="stat-bar-fill" style="width:${p}%"></div></div></div>`;
    });

    document.getElementById('balance').innerText = `$${bal.toFixed(2)}`;
    document.getElementById('sum-in').innerText = `+$${inc.toFixed(2)}`;
    document.getElementById('sum-out').innerText = `-$${exp.toFixed(2)}`;
    
    if(sessionPin) CRYPTO_CORE.lock(transactions, sessionPin).then(enc => localStorage.setItem('cp_v20_vault', JSON.stringify(enc)));
}

// Event Listeners for DOM elements
document.addEventListener("DOMContentLoaded", () => {
    document.getElementById('ledger-form').onsubmit = (e) => {
        e.preventDefault();
        transactions.push({ id: crypto.randomUUID(), text: document.getElementById('inp-text').value.toUpperCase(),
            amount: document.getElementById('inp-amt').value * (document.getElementById('inp-type').value === 'income' ? 1 : -1),
            category: document.getElementById('inp-cat').value, date: document.getElementById('inp-date').value });
        document.getElementById('ledger-form').reset(); refreshTime(); syncUI();
    };
});

function factoryReset() { if(confirm("NUKE ALL DATA?")) { localStorage.clear(); location.reload(); } }
function purgeHistory() { if(confirm("PURGE LEDGER?")) { transactions = []; syncUI(); } }
function downloadCSV() {
    let csv = 'Date,Desc,Amt\n'; transactions.forEach(t => csv += `${t.date},${t.text},${t.amount}\n`);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='cash_platinum.csv'; a.click();
}
const refreshTime = () => { const n = new Date(); n.setMinutes(n.getMinutes() - n.getTimezoneOffset()); document.getElementById('inp-date').value = n.toISOString().slice(0, 16); };