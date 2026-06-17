const { ipcRenderer } = require('electron');

let currentUser = null;
let currentCompany = null;
let currentShift = null;
let cart = [];
let totalSalesCash = 0;
let currentCategory = 'all';
let selectedPayment = 'cash';
let currentShiftId = null;
let taxRate = 0;

async function submitLogin() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value.trim();
    if (!username || !password) return alert('أدخل اسم المستخدم وكلمة المرور');

    const result = await ipcRenderer.invoke('login', { username, password });
    if (!result.success) {
        alert(result.error || 'بيانات الدخول خاطئة');
        return;
    }
    currentUser = result.user;
    document.getElementById('current-user-display').innerText = currentUser.full_name;
    document.getElementById('user-role-badge').innerText = currentUser.role;

    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-main').style.display = 'flex';

    await loadCompanyData();
    await openShiftIfNeeded();

    if (!currentCompany.name || taxRate === 0) {
        openCompanyModal();
    } else {
        switchTab('pos');
    }
}

async function loadCompanyData() {
    const company = await ipcRenderer.invoke('get-company');
    if (company) {
        currentCompany = company;
        taxRate = company.tax_rate || 0;
        document.getElementById('app-restaurant-name').innerText = currentCompany.name;
        document.getElementById('app-title').innerText = currentCompany.name;
    }
}

function openCompanyModal() {
    document.getElementById('company-name').value = currentCompany ? currentCompany.name : '';
    document.getElementById('company-phone').value = currentCompany ? currentCompany.phone : '';
    document.getElementById('company-address').value = currentCompany ? currentCompany.address : '';
    document.getElementById('company-tax').value = currentCompany ? currentCompany.tax_number || '' : '';
    document.getElementById('company-tax-rate').value = currentCompany ? currentCompany.tax_rate || 0 : 0;
    document.getElementById('company-modal').style.display = 'flex';
}

async function saveCompanyFromModal() {
    const name = document.getElementById('company-name').value.trim();
    const phone = document.getElementById('company-phone').value.trim();
    const address = document.getElementById('company-address').value.trim();
    const tax_number = document.getElementById('company-tax').value.trim();
    const tax_rate = parseFloat(document.getElementById('company-tax-rate').value) || 0;
    if (!name) { alert('اسم المطعم مطلوب'); return; }
    
    await ipcRenderer.invoke('update-company', { name, phone, address, tax_number, tax_rate, userId: currentUser.id });
    currentCompany.name = name;
    currentCompany.phone = phone;
    currentCompany.address = address;
    currentCompany.tax_number = tax_number;
    currentCompany.tax_rate = tax_rate;
    taxRate = tax_rate;

    document.getElementById('app-restaurant-name').innerText = name;
    document.getElementById('app-title').innerText = name;
    document.getElementById('company-modal').style.display = 'none';
    switchTab('pos');
}

async function openShiftIfNeeded() {
    const today = new Date().toISOString().slice(0,10);
    const shift = await ipcRenderer.invoke('db-get', "SELECT * FROM shifts WHERE company_id=? AND date=? AND status='open' AND user_id=?", [currentCompany.id, today, currentUser.id]);
    if (shift) {
        currentShift = shift;
        currentShiftId = shift.id;
        const total = await ipcRenderer.invoke('db-get', "SELECT COALESCE(SUM(total),0) as total FROM orders WHERE company_id=? AND date=? AND shift_id=?", [currentCompany.id, today, currentShift.id]);
        totalSalesCash = total ? total.total : 0;
    } else {
        const opening = prompt('أدخل رصيد افتتاح الصندوق (ر.س):', '0');
        const openingCash = parseFloat(opening) || 0;
        const result = await ipcRenderer.invoke('open-shift', { company_id: currentCompany.id, user_id: currentUser.id, opening_cash: openingCash });
        if (result.success) currentShiftId = result.shiftId;
    }
}

async function switchTab(tab) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.nav-btn[data-tab="${tab}"]`).classList.add('active');
    const main = document.getElementById('main-content');
    main.innerHTML = '';
    
    if (tab === 'dashboard') await renderDashboard();
    else if (tab === 'pos') await renderPOS();
    else if (tab === 'products') await renderProducts();
    else if (tab === 'categories') await renderCategories();
    else if (tab === 'settings') await renderSettings();
    // قم باستدعاء باقي التبويبات بنفس الطريقة...
}

// ========= نقطة البيع (POS) =========
async function renderPOS() {
    const categories = await ipcRenderer.invoke('db-query', "SELECT * FROM categories WHERE company_id=?", [currentCompany.id]);
    const catBtns = categories.map(c => `<button class="cat-btn" onclick="filterPOS('${c.id}')">${c.name}</button>`).join('');

    document.getElementById('main-content').innerHTML = `
        <div class="pos-container">
            <div class="menu-section">
                <div class="category-grid">
                    <button class="cat-btn active" onclick="filterPOS('all')">الكل</button>
                    ${catBtns}
                </div>
                <div class="items-grid" id="pos-items-grid"></div>
            </div>
            <div class="invoice-section">
                <input type="text" id="pos-customer-name" placeholder="اسم العميل (اختياري)" style="width:100%; padding:8px; margin-bottom:10px;">
                <div class="cart-items" id="cart-items"></div>
                <div class="cart-total">
                    <div>المجموع: <span id="cart-subtotal">0.00</span> ر.س</div>
                    <div>الضريبة (${taxRate}%): <span id="cart-tax">0.00</span> ر.س</div>
                    <div>الإجمالي: <span id="cart-total">0.00</span> ر.س</div>
                </div>
                <div class="payment-options">
                    <button class="active" onclick="selectPayment('cash')">نقدي</button>
                    <button onclick="selectPayment('card')">بطاقة</button>
                </div>
                <button class="btn btn-success" style="width:100%; margin-top:10px;" onclick="checkoutPOS()">طباعة وإنهاء الطلب</button>
            </div>
        </div>
    `;
    await filterPOS('all');
    updateCartUI();
}

function selectPayment(method) {
    selectedPayment = method;
    document.querySelectorAll('.payment-options button').forEach(b => b.classList.remove('active'));
    document.querySelector(`.payment-options button[onclick="selectPayment('${method}')"]`).classList.add('active');
}

async function filterPOS(catId) {
    currentCategory = catId;
    let products = catId === 'all' ? 
        await ipcRenderer.invoke('db-query', "SELECT * FROM products WHERE company_id=?", [currentCompany.id]) :
        await ipcRenderer.invoke('db-query', "SELECT * FROM products WHERE company_id=? AND category_id=?", [currentCompany.id, catId]);
    renderPOSItems(products);
}

function renderPOSItems(products) {
    const grid = document.getElementById('pos-items-grid');
    if (!grid) return;
    const userData = require('electron').app.getPath('userData');
    grid.innerHTML = products.map(p => {
        const safeImageUrl = p.image ? `file://${encodeURI(userData.replace(/\\/g, '/'))}/${encodeURIComponent(p.image)}` : '';
        return `
        <div class="item-card" onclick="addToCartPOS(${p.id})">
            ${p.image ? `<img src="${safeImageUrl}" style="width:100%; height:80px; object-fit:cover; border-radius:4px;">` : `<div style="height:80px; background:#eee; border-radius:4px;"></div>`}
            <div>${p.name}</div>
            <div style="font-weight:bold; color:#e67e22;">${p.price.toFixed(2)} ر.س</div>
        </div>
    `}).join('');
}

async function addToCartPOS(productId) {
    const product = await ipcRenderer.invoke('db-get', "SELECT * FROM products WHERE id=?", [productId]);
    if (!product) return;
    const existing = cart.find(i => i.id === productId);
    if (existing) existing.qty += 1;
    else cart.push({ ...product, qty: 1 });
    updateCartUI();
}

function updateCartUI() {
    let subtotal = 0;
    document.getElementById('cart-items').innerHTML = cart.map((item, idx) => {
        subtotal += item.price * item.qty;
        return `<div class="cart-item">
            <span>${item.name} x${item.qty}</span>
            <span>${(item.price * item.qty).toFixed(2)}</span>
            <button class="btn btn-danger btn-sm" onclick="cart.splice(${idx}, 1); updateCartUI();">×</button>
        </div>`;
    }).join('');
    const tax = subtotal * (taxRate / 100);
    document.getElementById('cart-subtotal').innerText = subtotal.toFixed(2);
    document.getElementById('cart-tax').innerText = tax.toFixed(2);
    document.getElementById('cart-total').innerText = (subtotal + tax).toFixed(2);
}

async function checkoutPOS() {
    if (cart.length === 0) return alert('السلة فارغة');
    const customerName = document.getElementById('pos-customer-name').value.trim() || 'عميل نقدي';
    const subtotal = cart.reduce((s, i) => s + (i.price * i.qty), 0);
    const tax = subtotal * (taxRate / 100);
    const total = subtotal + tax;

    const result = await ipcRenderer.invoke('create-order', {
        company_id: currentCompany.id,
        user_id: currentUser.id,
        customer_name: customerName,
        total: subtotal,
        tax: tax,
        total_with_tax: total,
        payment_method: selectedPayment,
        paid_amount: total,
        shift_id: currentShiftId,
        items: cart
    });

    if (result.success) {
        await printInvoice(result.orderId, cart, subtotal, tax, total, customerName);
        cart = [];
        document.getElementById('pos-customer-name').value = '';
        updateCartUI();
    }
}

async function printInvoice(orderId, items, subtotal, tax, total, customerName) {
    let rows = items.map(i => `<tr><td>${i.name}</td><td>${i.qty}</td><td>${(i.price * i.qty).toFixed(2)}</td></tr>`).join('');
    const html = `
    <!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><style>
        @page { size: 74mm auto; margin: 0; }
        body { font-family: 'Tajawal', sans-serif; direction: rtl; width: 74mm; padding: 2mm; font-size: 12px; }
        .center { text-align: center; } .bold { font-weight: bold; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 3px; text-align: right; border-bottom: 1px dashed #000; }
    </style></head><body>
        <div class="center bold">
            <h3>${currentCompany.name}</h3>
            <p>فاتورة #${orderId}</p>
            <p>العميل: ${customerName}</p>
        </div>
        <table><tr><th>الصنف</th><th>كم</th><th>السعر</th></tr>${rows}</table>
        <div style="margin-top:10px;">
            <p>المجموع: ${subtotal.toFixed(2)} ر.س</p>
            <p>الضريبة: ${tax.toFixed(2)} ر.س</p>
            <p class="bold">الإجمالي: ${total.toFixed(2)} ر.س</p>
        </div>
        <div class="center" style="margin-top:15px; font-size:10px;">تصميم المهندس عبدالرحمن الأكوع</div>
    </body></html>`;

    await ipcRenderer.invoke('print-thermal', { html, userId: currentUser.id });
}

async function renderSettings() {
    document.getElementById('main-content').innerHTML = `
        <div class="page-header"><h1>الإعدادات</h1></div>
        <div style="background:white; padding:20px; border-radius:10px;">
            <h3>بيانات المطعم</h3>
            <p><strong>الاسم:</strong> ${currentCompany.name}</p>
            <button class="btn btn-primary" onclick="openCompanyModal()">تعديل البيانات</button>
        </div>
    `;
}

// ========= لوحة المفاتيح الافتراضية (Touch Keyboard) =========
let activeInput = null;

document.addEventListener('focusin', (e) => {
    if(e.target.tagName === 'INPUT' && (e.target.type === 'text' || e.target.type === 'number' || e.target.type === 'password')) {
        activeInput = e.target;
        document.getElementById('keyboard').classList.add('active');
    }
});

function pressKey(key) {
    if (!activeInput) return;
    if (key === 'Backspace') {
        activeInput.value = activeInput.value.slice(0, -1);
    } else if (key === 'Clear') {
        activeInput.value = '';
    } else {
        activeInput.value += key;
    }
    activeInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function hideKeyboard() {
    document.getElementById('keyboard').classList.remove('active');
    if (activeInput) activeInput.blur();
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('input') && !e.target.closest('#keyboard')) {
        hideKeyboard();
    }
});

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
});
