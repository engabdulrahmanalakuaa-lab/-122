const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');

let mainWindow;
let db;
const dbDir = app.getPath('userData');
const dbPath = path.join(dbDir, 'restaurant_system.db');
const backupDir = path.join(dbDir, 'backups');
const logsDir = path.join(dbDir, 'logs');
const imagesDir = path.join(dbDir, 'product-images');

if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

function initializeDatabase() {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // إنشاء الجداول (نفس الهيكل السابق)
    db.exec(`
        CREATE TABLE IF NOT EXISTS companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT,
            address TEXT,
            tax_number TEXT,
            tax_rate REAL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            full_name TEXT,
            username TEXT UNIQUE,
            password_hash TEXT,
            role TEXT DEFAULT 'cashier',
            is_blocked INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
        CREATE TABLE IF NOT EXISTS permissions (
            user_id INTEGER PRIMARY KEY,
            can_edit_products INTEGER DEFAULT 0,
            can_edit_prices INTEGER DEFAULT 0,
            can_edit_users INTEGER DEFAULT 0,
            can_view_reports INTEGER DEFAULT 0,
            can_close_shift INTEGER DEFAULT 0,
            can_refund INTEGER DEFAULT 0,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            category_id INTEGER,
            price REAL,
            cost REAL DEFAULT 0,
            barcode TEXT,
            recipe TEXT,
            image TEXT,
            unit TEXT DEFAULT 'قطعة',
            daily_forecast INTEGER DEFAULT 0,
            monthly_forecast INTEGER DEFAULT 0,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(category_id) REFERENCES categories(id)
        );
        CREATE TABLE IF NOT EXISTS raw_materials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            unit TEXT,
            current_stock REAL DEFAULT 0,
            min_stock REAL DEFAULT 0,
            purchase_price REAL DEFAULT 0,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
        CREATE TABLE IF NOT EXISTS tables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            status TEXT DEFAULT 'free',
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
        CREATE TABLE IF NOT EXISTS waiters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            user_id INTEGER,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            user_id INTEGER,
            opening_cash REAL,
            closing_cash REAL,
            expected_cash REAL,
            cash_difference REAL,
            date TEXT,
            status TEXT DEFAULT 'open',
            closed_at DATETIME,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            table_id INTEGER,
            waiter_id INTEGER,
            user_id INTEGER,
            customer_name TEXT,
            total REAL,
            tax REAL DEFAULT 0,
            total_with_tax REAL,
            discount REAL DEFAULT 0,
            payment_method TEXT DEFAULT 'cash',
            paid_amount REAL,
            change_amount REAL,
            date TEXT,
            time TEXT,
            shift_id INTEGER,
            status TEXT DEFAULT 'completed',
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(table_id) REFERENCES tables(id),
            FOREIGN KEY(waiter_id) REFERENCES waiters(id),
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(shift_id) REFERENCES shifts(id)
        );
        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            product_id INTEGER,
            qty INTEGER,
            price REAL,
            FOREIGN KEY(order_id) REFERENCES orders(id),
            FOREIGN KEY(product_id) REFERENCES products(id)
        );
        CREATE TABLE IF NOT EXISTS refunds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            user_id INTEGER,
            amount REAL,
            reason TEXT,
            date TEXT,
            FOREIGN KEY(order_id) REFERENCES orders(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS inventory_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            material_id INTEGER,
            qty_change REAL,
            type TEXT,
            reference TEXT,
            date TEXT,
            user_id INTEGER,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(material_id) REFERENCES raw_materials(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            month TEXT,
            category TEXT,
            description TEXT,
            amount REAL,
            type TEXT DEFAULT 'fixed',
            date TEXT,
            user_id INTEGER,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT,
            details TEXT,
            ip TEXT,
            date DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS settings (
            company_id INTEGER PRIMARY KEY,
            safe_mode INTEGER DEFAULT 0,
            currency TEXT DEFAULT 'SAR',
            pagination INTEGER DEFAULT 20,
            show_company_screen INTEGER DEFAULT 1,
            profit_margin_percent REAL DEFAULT 30,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
    `);

    // إدخال بيانات افتراضية إذا لم توجد شركة
    const company = db.prepare("SELECT COUNT(*) as count FROM companies").get();
    if (company.count === 0) {
        const companyId = 1;
        db.prepare("INSERT INTO companies (id, name, phone, address, tax_rate) VALUES (?, ?, ?, ?, ?)")
          .run(companyId, 'مطعم كيان الشواية البخاري', '773579486', 'اليمن', 15);

        const hash = bcrypt.hashSync('77357233199477', 10);
        db.prepare("INSERT INTO users (id, company_id, full_name, username, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)")
          .run(1, companyId, 'المدير العام', 'admin', hash, 'admin');
        db.prepare("INSERT INTO permissions (user_id, can_edit_products, can_edit_prices, can_edit_users, can_view_reports, can_close_shift, can_refund) VALUES (?,1,1,1,1,1,1)")
          .run(1);
        db.prepare("INSERT INTO settings (company_id) VALUES (?)").run(companyId);

        const categories = ['أكلات شعبية', 'غداء', 'المعصوب', 'مشروبات'];
        const insertCat = db.prepare("INSERT INTO categories (company_id, name) VALUES (?, ?)");
        categories.forEach(cat => insertCat.run(companyId, cat));
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1024,
        minHeight: 720,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
    initializeDatabase();
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        if (db) db.close();
        app.quit();
    }
});

// دوال مساعدة لتسجيل التدقيق والنسخ الاحتياطي
function logAudit(userId, action, details) {
    const stmt = db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)");
    stmt.run(userId, action, details);
}

function backupDatabase() {
    const backupFile = path.join(backupDir, `backup_${new Date().toISOString().slice(0,10)}.db`);
    try {
        fs.copyFileSync(dbPath, backupFile);
        const files = fs.readdirSync(backupDir).filter(f => f.startsWith('backup_'));
        if (files.length > 7) {
            const sorted = files.sort();
            for (let i = 0; i < sorted.length - 7; i++) {
                fs.unlinkSync(path.join(backupDir, sorted[i]));
            }
        }
        return { success: true, path: backupFile };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ========== IPC Handlers (جميع الدوال متزامنة الآن) ==========

ipcMain.handle('db-query', (event, sql, params) => {
    try {
        const stmt = db.prepare(sql);
        return stmt.all(params || []);
    } catch (e) {
        throw e;
    }
});

ipcMain.handle('db-run', (event, sql, params) => {
    try {
        const stmt = db.prepare(sql);
        const info = stmt.run(params || []);
        return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    } catch (e) {
        throw e;
    }
});

ipcMain.handle('db-get', (event, sql, params) => {
    try {
        const stmt = db.prepare(sql);
        return stmt.get(params || []);
    } catch (e) {
        throw e;
    }
});

ipcMain.handle('login', async (event, { username, password }) => {
    const user = db.prepare("SELECT * FROM users WHERE username=? AND is_blocked=0").get(username);
    if (!user) return { success: false, error: 'اسم المستخدم غير موجود' };
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return { success: false, error: 'كلمة المرور خاطئة' };
    const perms = db.prepare("SELECT * FROM permissions WHERE user_id=?").get(user.id) || {};
    logAudit(user.id, 'login', 'تسجيل دخول');
    return { success: true, user: { ...user, permissions: perms } };
});

ipcMain.handle('create-user', (event, data) => {
    const { company_id, full_name, username, password, role, currentUserId } = data;
    const hash = bcrypt.hashSync(password, 10);
    const insertUser = db.prepare("INSERT INTO users (company_id, full_name, username, password_hash, role) VALUES (?, ?, ?, ?, ?)");
    const info = insertUser.run(company_id, full_name, username, hash, role);
    const userId = info.lastInsertRowid;
    const perms = {
        admin: { can_edit_products: 1, can_edit_prices: 1, can_edit_users: 1, can_view_reports: 1, can_close_shift: 1, can_refund: 1 },
        accountant: { can_edit_products: 0, can_edit_prices: 0, can_edit_users: 0, can_view_reports: 1, can_close_shift: 1, can_refund: 0 },
        cashier: { can_edit_products: 0, can_edit_prices: 0, can_edit_users: 0, can_view_reports: 0, can_close_shift: 0, can_refund: 0 }
    };
    const p = perms[role] || perms.cashier;
    db.prepare("INSERT INTO permissions (user_id, can_edit_products, can_edit_prices, can_edit_users, can_view_reports, can_close_shift, can_refund) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(userId, p.can_edit_products, p.can_edit_prices, p.can_edit_users, p.can_view_reports, p.can_close_shift, p.can_refund);
    logAudit(currentUserId, 'create_user', `إنشاء مستخدم: ${username}`);
    return { success: true, id: userId };
});

ipcMain.handle('update-user', (event, data) => {
    const { id, full_name, username, password, role, currentUserId } = data;
    const currentUser = db.prepare("SELECT role FROM users WHERE id=?").get(currentUserId);
    if (!currentUser || (currentUser.role !== 'admin' && currentUserId !== id)) {
        return { success: false, error: 'ليس لديك صلاحية لتعديل هذا المستخدم' };
    }
    if (password && password.length > 0) {
        const hash = bcrypt.hashSync(password, 10);
        db.prepare("UPDATE users SET full_name=?, username=?, password_hash=?, role=? WHERE id=?")
          .run(full_name, username, hash, role, id);
    } else {
        db.prepare("UPDATE users SET full_name=?, username=?, role=? WHERE id=?")
          .run(full_name, username, role, id);
    }
    logAudit(currentUserId, 'update_user', `تحديث بيانات المستخدم: ${username}`);
    return { success: true };
});

ipcMain.handle('toggle-block', (event, { userId, currentUserId }) => {
    const user = db.prepare("SELECT is_blocked FROM users WHERE id=?").get(userId);
    if (!user) return { success: false, error: 'المستخدم غير موجود' };
    db.prepare("UPDATE users SET is_blocked=? WHERE id=?").run(user.is_blocked ? 0 : 1, userId);
    logAudit(currentUserId, 'toggle_block', `تغيير حالة الحظر للمستخدم #${userId}`);
    return { success: true };
});

ipcMain.handle('get-company', () => {
    return db.prepare("SELECT * FROM companies LIMIT 1").get();
});

ipcMain.handle('update-company', (event, data) => {
    const { name, phone, address, tax_number, tax_rate, userId } = data;
    db.prepare("UPDATE companies SET name=?, phone=?, address=?, tax_number=?, tax_rate=? WHERE id=1")
      .run(name, phone, address, tax_number, tax_rate || 0);
    logAudit(userId, 'update_company', 'تعديل بيانات المطعم');
    return { success: true };
});

ipcMain.handle('get-settings', (event, companyId) => {
    return db.prepare("SELECT * FROM settings WHERE company_id=?").get(companyId) || {};
});

ipcMain.handle('save-settings', (event, { companyId, settings, userId }) => {
    db.prepare("UPDATE settings SET safe_mode=?, pagination=?, profit_margin_percent=? WHERE company_id=?")
      .run(settings.safe_mode || 0, settings.pagination || 20, settings.profit_margin_percent || 30, companyId);
    return { success: true };
});

ipcMain.handle('save-product', (event, data) => {
    const { id, company_id, name, price, cost, category_id, barcode, recipe, unit, image, userId } = data;
    if (id) {
        db.prepare("UPDATE products SET name=?, price=?, category_id=?, cost=?, barcode=?, recipe=?, unit=?, image=? WHERE id=? AND company_id=?")
          .run(name, price, category_id, cost || 0, barcode, recipe, unit, image, id, company_id);
        logAudit(userId, 'edit_product', `تعديل منتج: ${name}`);
        return { success: true, id };
    } else {
        const info = db.prepare("INSERT INTO products (company_id, name, price, category_id, cost, barcode, recipe, unit, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(company_id, name, price, category_id, cost || 0, barcode, recipe, unit, image);
        logAudit(userId, 'add_product', `إضافة منتج: ${name}`);
        return { success: true, id: info.lastInsertRowid };
    }
});

ipcMain.handle('delete-product', (event, { id, company_id, userId }) => {
    db.prepare("DELETE FROM products WHERE id=? AND company_id=?").run(id, company_id);
    logAudit(userId, 'delete_product', `حذف منتج #${id}`);
    return { success: true };
});

ipcMain.handle('save-category', (event, { company_id, name, userId }) => {
    const info = db.prepare("INSERT INTO categories (company_id, name) VALUES (?, ?)").run(company_id, name);
    return { success: true, id: info.lastInsertRowid };
});

ipcMain.handle('delete-category', (event, { id, userId }) => {
    db.prepare("DELETE FROM categories WHERE id=?").run(id);
    return { success: true };
});

ipcMain.handle('save-material', (event, data) => {
    const { id, company_id, name, unit, min_stock, purchase_price } = data;
    if (id) {
        db.prepare("UPDATE raw_materials SET name=?, unit=?, min_stock=?, purchase_price=? WHERE id=? AND company_id=?")
          .run(name, unit, min_stock, purchase_price, id, company_id);
        return { success: true, id };
    } else {
        const info = db.prepare("INSERT INTO raw_materials (company_id, name, unit, min_stock, purchase_price) VALUES (?, ?, ?, ?, ?)")
          .run(company_id, name, unit, min_stock, purchase_price);
        return { success: true, id: info.lastInsertRowid };
    }
});

ipcMain.handle('delete-material', (event, { id, company_id }) => {
    db.prepare("DELETE FROM raw_materials WHERE id=? AND company_id=?").run(id, company_id);
    return { success: true };
});

ipcMain.handle('add-stock', (event, { material_id, qty, userId }) => {
    db.prepare("UPDATE raw_materials SET current_stock = current_stock + ? WHERE id=?").run(qty, material_id);
    db.prepare("INSERT INTO inventory_transactions (company_id, material_id, qty_change, type, reference, date, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(1, material_id, qty, 'supply', 'توريد يدوي', new Date().toISOString().slice(0,10), userId);
    logAudit(userId, 'add_stock', `توريد مادة #${material_id} بكمية ${qty}`);
    return { success: true };
});

ipcMain.handle('create-order', (event, data) => {
    const { company_id, table_id, waiter_id, user_id, customer_name, total, tax, total_with_tax, discount, payment_method, paid_amount, shift_id, items } = data;
    const today = new Date().toISOString().slice(0,10);
    const time = new Date().toLocaleTimeString('ar-SA');

    const insertOrder = db.prepare(`INSERT INTO orders 
        (company_id, table_id, waiter_id, user_id, customer_name, total, tax, total_with_tax, discount, payment_method, paid_amount, date, time, shift_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const info = insertOrder.run(company_id, table_id, waiter_id, user_id, customer_name, total, tax || 0, total_with_tax || total, discount || 0, payment_method, paid_amount, today, time, shift_id);
    const orderId = info.lastInsertRowid;

    const insertItem = db.prepare("INSERT INTO order_items (order_id, product_id, qty, price) VALUES (?, ?, ?, ?)");
    for (let item of items) {
        insertItem.run(orderId, item.id, item.qty, item.price);
    }

    if (table_id) {
        db.prepare("UPDATE tables SET status='occupied' WHERE id=?").run(table_id);
    }

    logAudit(user_id, 'create_order', `طلب #${orderId} للعميل ${customer_name}`);
    return { success: true, orderId };
});

ipcMain.handle('refund-order', (event, { orderId, userId, reason }) => {
    const order = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
    if (!order) return { success: false, error: 'الطلب غير موجود' };
    if (order.status === 'refunded') return { success: false, error: 'الطلب مرتجع مسبقاً' };
    db.prepare("UPDATE orders SET status='refunded' WHERE id=?").run(orderId);
    db.prepare("INSERT INTO refunds (order_id, user_id, amount, reason, date) VALUES (?, ?, ?, ?, ?)")
      .run(orderId, userId, order.total, reason, new Date().toISOString());
    logAudit(userId, 'refund_order', `إرجاع طلب #${orderId}`);
    return { success: true };
});

ipcMain.handle('open-shift', (event, { company_id, user_id, opening_cash }) => {
    const today = new Date().toISOString().slice(0,10);
    const info = db.prepare("INSERT INTO shifts (company_id, user_id, opening_cash, date, status) VALUES (?, ?, ?, ?, ?)")
      .run(company_id, user_id, opening_cash, today, 'open');
    logAudit(user_id, 'open_shift', `فتح وردية #${info.lastInsertRowid}`);
    return { success: true, shiftId: info.lastInsertRowid };
});

ipcMain.handle('close-shift', (event, { shiftId, actual_cash, userId }) => {
    const shift = db.prepare("SELECT * FROM shifts WHERE id=?").get(shiftId);
    if (!shift) return { success: false, error: 'الوردية غير موجودة' };
    if (shift.status !== 'open') return { success: false, error: 'الوردية مغلقة' };

    const totalSales = db.prepare("SELECT COALESCE(SUM(total),0) as total FROM orders WHERE shift_id=?").get(shiftId).total;
    const expected = shift.opening_cash + totalSales;
    const difference = actual_cash - expected;

    db.prepare("UPDATE shifts SET closing_cash=?, expected_cash=?, cash_difference=?, status='closed', closed_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(actual_cash, expected, difference, shiftId);

    backupDatabase();
    logAudit(userId, 'close_shift', `إغلاق وردية #${shiftId}، الفارق: ${difference}`);
    return { success: true, expected, difference };
});

ipcMain.handle('add-expense', (event, data) => {
    const { company_id, month, category, description, amount, type, user_id } = data;
    db.prepare("INSERT INTO expenses (company_id, month, category, description, amount, type, date, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(company_id, month, category, description, amount, type, new Date().toISOString().slice(0,10), user_id);
    logAudit(user_id, 'add_expense', `إضافة مصروف: ${description} بقيمة ${amount}`);
    return { success: true };
});

ipcMain.handle('delete-expense', (event, { id, userId }) => {
    db.prepare("DELETE FROM expenses WHERE id=?").run(id);
    logAudit(userId, 'delete_expense', `حذف مصروف #${id}`);
    return { success: true };
});

ipcMain.handle('get-sales-report', (event, { startDate, endDate, companyId }) => {
    const rows = db.prepare(`SELECT date, COUNT(*) as count, SUM(total) as total, SUM(tax) as tax, SUM(total_with_tax) as total_with_tax,
                payment_method, SUM(paid_amount) as paid
                FROM orders WHERE company_id=? AND date BETWEEN ? AND ? AND status='completed'
                GROUP BY date, payment_method ORDER BY date`)
      .all(companyId, startDate, endDate);
    return rows;
});

ipcMain.handle('get-profit-report', (event, { startDate, endDate, companyId }) => {
    const orders = db.prepare(`SELECT o.id, o.total, oi.product_id, oi.qty, p.cost
                FROM orders o
                JOIN order_items oi ON o.id = oi.order_id
                JOIN products p ON oi.product_id = p.id
                WHERE o.company_id=? AND o.date BETWEEN ? AND ? AND o.status='completed'`)
      .all(companyId, startDate, endDate);
    let totalCost = 0;
    for (let row of orders) {
        totalCost += (row.cost || 0) * row.qty;
    }
    const totalSales = orders.reduce((sum, o) => sum + o.total, 0);
    const profit = totalSales - totalCost;
    return { totalSales, totalCost, profit };
});

ipcMain.handle('get-expense-report', (event, { startDate, endDate, companyId }) => {
    const rows = db.prepare("SELECT category, SUM(amount) as total FROM expenses WHERE company_id=? AND date BETWEEN ? AND ? GROUP BY category")
      .all(companyId, startDate, endDate);
    return rows;
});

ipcMain.handle('print-thermal', async (event, { html, userId }) => {
    try {
        const printer = new ThermalPrinter({
            type: PrinterTypes.EPSON,
            interface: 'USB',
            options: { timeout: 5000 }
        });
        await printer.connect();
        await printer.print(html);
        await printer.disconnect();
        logAudit(userId, 'print_receipt', 'طباعة فاتورة حرارية');
        return { success: true, method: 'thermal' };
    } catch (e) {
        console.warn('فشلت الطباعة الحرارية، استخدام نافذة المتصفح:', e.message);
        if (mainWindow) {
            mainWindow.webContents.send('fallback-print', html);
        }
        return { success: true, method: 'fallback' };
    }
});

ipcMain.handle('save-product-image', (event, { fileName, buffer }) => {
    try {
        const filePath = path.join(imagesDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(buffer));
        return { success: true, imagePath: `product-images/${fileName}` };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('manual-backup', () => {
    return backupDatabase();
});

ipcMain.handle('save-table', (event, { company_id, name }) => {
    db.prepare("INSERT INTO tables (company_id, name) VALUES (?, ?)").run(company_id, name);
    return { success: true };
});

ipcMain.handle('delete-table', (event, { id }) => {
    db.prepare("DELETE FROM tables WHERE id=?").run(id);
    return { success: true };
});

ipcMain.handle('save-waiter', (event, { company_id, name }) => {
    db.prepare("INSERT INTO waiters (company_id, name) VALUES (?, ?)").run(company_id, name);
    return { success: true };
});

ipcMain.handle('delete-waiter', (event, { id }) => {
    db.prepare("DELETE FROM waiters WHERE id=?").run(id);
    return { success: true };
});

ipcMain.handle('get-audit-log', (event, { limit = 100 }) => {
    return db.prepare("SELECT * FROM audit_log ORDER BY date DESC LIMIT ?").all(limit);
});
