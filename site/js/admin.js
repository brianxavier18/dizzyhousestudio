const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API_URL = isLocal ? 'http://localhost:3001/api' : '/api';
let updateInterval = null;
let currentPortfolio = [];
let currentAgendaList = [];
let activeView = 'dashboard';
let refreshPaused = false;
let refreshPauseReason = '';
let pendingRequests = new Map(); // Rastrear requisições ativas
let lastRefreshTime = 0;
let dataCache = { dashboard: null, agenda: null, clients: null, blocked: null, portfolio: null };
let dataCacheVersion = { dashboard: 0, agenda: 0, clients: 0, blocked: 0, portfolio: 0 };

// Debounce utility
function debounce(func, delay) {
    let timeoutId;
    return function(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func(...args), delay);
    };
}

// Throttle para refresh
function throttleRefresh(func, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// Cancelar requisição anterior se ainda pendente
function cancelPendingRequest(key) {
    if (pendingRequests.has(key)) {
        const controller = pendingRequests.get(key);
        controller.abort();
        pendingRequests.delete(key);
    }
}


// --- AUTH & NAVIGATION ---

// Callback global do Google
window.handleCredentialResponse = function(response) {
    // Envia o JWT pro backend
    fetch(`${API_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential })
    })
    .then(async res => {
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.erro || `Erro ${res.status}`);
        }
        return res.json();
    })
    .then(data => {
        document.getElementById('login-screen').style.display = 'none';
        const panel = document.getElementById('admin-panel');
        panel.style.display = 'flex'; 
        
        switchView('dashboard');
        initDashboard();
    })
    .catch(e => {
        console.error(e);
        const msgEl = document.getElementById('login-msg');
        if(msgEl) msgEl.innerText = 'Login falhou: ' + e.message;
        else alert('Login falhou: ' + e.message);
    });
}

function logout() {
    location.reload();
}

function switchView(viewName) {
    activeView = viewName;
    
    // Menu Active State
    document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
    
    // Find index to highlight menu
    const menuIndex = ['dashboard', 'agenda', 'clientes', 'portfolio', 'deploy', 'produtos', 'vendas'].indexOf(viewName);
    if(menuIndex >= 0) {
        const items = document.querySelectorAll('.sidebar .menu-item');
        if(items[menuIndex]) items[menuIndex].classList.add('active');
    }

    // Title Update
    const titles = {
        'dashboard': 'Visão Geral',
        'agenda': 'Gerenciar Agenda',
        'clientes': 'CRM Clientes',
        'portfolio': 'Editor Portfólio',
        'deploy': 'Deploy & Publicação',
        'produtos': 'Gerenciar Produtos',
        'vendas': 'Controle de Vendas'
    };
    if(titles[viewName]) document.getElementById('page-title').innerText = titles[viewName];

    // Show Section
    const views = ['dashboard', 'agenda', 'clientes', 'portfolio', 'deploy', 'produtos', 'vendas'];
    views.forEach(v => {
        const el = document.getElementById(`view-${v}`);
        if(el) {
            el.style.display = 'none';
            el.classList.remove('active');
        }
    });

    const targetEl = document.getElementById(`view-${viewName}`);
    if(targetEl) {
        targetEl.style.display = 'block';
        targetEl.classList.add('active');
    }

    // Refresh apenas dados desta aba
    refreshViewData(viewName);
}


// --- INITIALIZATION ---

function initDashboard() {
    refreshViewData(activeView);
    fetchConfig();
    
    // Refresh automático SELETIVO: 15 segundos (reduzido de 5)
    // Apenas atualiza dados da aba ativa
    updateInterval = setInterval(() => {
        refreshViewData(activeView);
    }, 15000);
}

// Refresh seletivo por aba
function refreshViewData(view) {
    if (refreshPaused) {
        console.log('Refresh pausado:', refreshPauseReason);
        return;
    }
    const now = Date.now();
    if (now - lastRefreshTime < 2000) return; // Evitar refresh muito frequente
    lastRefreshTime = now;
    
    switch(view) {
        case 'dashboard':
            fetchDashboardSummary();
            break;
        case 'agenda':
            fetchFullAgenda();
            break;
        case 'clientes':
            fetchClients();
            break;
        case 'portfolio':
            fetchPortfolio();
            break;
        case 'produtos':
            loadProducts();
            break;
        case 'vendas':
            loadSales();
            break;
    }
}

function pauseRefresh(paused, reason = '') {
    refreshPaused = paused;
    refreshPauseReason = reason;
    if (!paused) {
        lastRefreshTime = Date.now();
    }
}

// Legacy: refreshAll mantido para compatibilidade, mas agora faz menos
function refreshAll() {
    refreshViewData(activeView);
}

// --- DASHBOARD WIDGETS ---

function fetchDashboardSummary() {
    fetch(`${API_URL}/admin/dashboard`)
    .then(res => res.json())
    .then(data => {
        if (!data || !data.financeiro || !Array.isArray(data.agendaHoje)) {
            console.error('Dados do dashboard incompletos:', data);
            return;
        }
        // Widgets
        document.getElementById('dash-money').innerText = `R$ ${Number(data.financeiro.projecaoSemana || 0).toLocaleString('pt-BR')},00`;
        document.getElementById('dash-reservas').innerText = `R$ ${Number(data.financeiro.totalReservas || 0).toLocaleString('pt-BR')},00`;
        document.getElementById('dash-vagas').innerText = data.vagasRestantes || 0;

        // Agenda Hoje
        const tbody = document.getElementById('dash-today-list');
        tbody.innerHTML = '';
        if(data.agendaHoje.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:15px; color:#555;">Nenhum cliente para hoje.</td></tr>';
        } else {
            data.agendaHoje.forEach(a => {
                tbody.innerHTML += `
                    <tr>
                        <td>${a.periodo}</td>
                        <td style="font-weight:bold; color:#fff;">${a.nome}</td>
                        <td>${a.tipo===1 ? 'Pequena (1h)' : 'Grande (2h+)'}</td>
                        <td><span class="status-badge status-${a.status.split(' ')[0]}">${a.status}</span></td>
                    </tr>
                `;
            });
        }
    });
}


// --- AGENDA MANAGEMENT ---

function fetchFullAgenda() {
    cancelPendingRequest('agenda');
    const controller = new AbortController();
    pendingRequests.set('agenda', controller);
    
    fetch(`${API_URL}/horarios`, { signal: controller.signal })
    .then(res => res.json())
    .then(data => {
        const tbody = document.getElementById('agenda-full-list');
        if (!tbody) return console.error('Table body not found');

        const list = data.agendamentos || [];
        currentAgendaList = list;

        if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:30px; color:#fff; font-size:1.2rem; border:1px solid #333;">Nenhum agendamento encontrado</td></tr>';
            return;
        }

        list.sort((a,b) => new Date(a.data) - new Date(b.data));
        
        // Usar DocumentFragment para construir HTML uma única vez
        const fragment = document.createDocumentFragment();
        
        list.forEach(a => {
            const dateFmt = new Date(a.data).toLocaleDateString('pt-BR');
            let statusColor = '#aaa';
            if(a.status === 'Confirmado') statusColor = '#0f0';
            if(a.status === 'Cancelado') statusColor = '#f00';
            if(a.status === 'Pendente Pagamento') statusColor = 'orange';

            const tr = document.createElement('tr');
            tr.className = 'agenda-row';
            tr.style.cssText = 'border-bottom: 1px solid #333; background:rgba(255,255,255,0.02);';
            tr.innerHTML = `
                <td style="padding: 15px 20px; color:#fff;">
                    <span style="font-weight:bold; font-size:1.1rem;">${dateFmt}</span><br> 
                    <span style="font-size:0.85rem; color:#ccc; text-transform:uppercase;">${a.periodo}</span>
                </td>
                <td style="padding: 15px 20px; color:#fff;">
                    <span class="client-name" style="font-weight:bold;">${a.nome}</span>
                    <div style="font-size: 0.8rem; color: #ccc;">${a.tipo === 1 ? 'Pequena' : 'Grande'}</div>
                </td>
                <td style="padding: 15px 20px;">
                    <span style="display:inline-block; padding: 4px 10px; border-radius: 4px; font-size: 0.8rem; color: ${statusColor}; border: 1px solid ${statusColor};">
                        ${a.status}
                    </span>
                </td>
                <td class="action-cell" style="padding: 15px 20px; text-align: right; white-space: nowrap;">
                    <button class="action-btn edit-btn" style="color:#fff; background:#004488; border:1px solid #003366; font-weight:bold; border-radius:6px; cursor:pointer; min-width:44px; min-height:44px; margin-right:10px;" onclick="editAppt(${a.id})">✏</button>
                    <button class="action-btn confirm-btn" style="color:#fff; background:#006600; border:1px solid #004400; font-weight:bold; border-radius:6px; cursor:pointer; min-width:44px; min-height:44px; margin-right:10px;" onclick="updateApptStatus(${a.id}, 'Confirmado')">✔</button>
                    <button class="action-btn delete-btn" style="color:#fff; background:#880000; border:1px solid #550000; font-weight:bold; border-radius:6px; cursor:pointer; min-width:44px; min-height:44px;" onclick="deleteAppt(${a.id})">✖</button>
                </td>
            `;
            fragment.appendChild(tr);
        });
        
        tbody.innerHTML = '';
        tbody.appendChild(fragment);
        pendingRequests.delete('agenda');
    })
    .catch(e => {
        if (e.name === 'AbortError') return;
        console.error('Agenda Error:', e);
        const el = document.getElementById('agenda-full-list');
        if(el) el.innerHTML = `<tr><td colspan="4" style="color:red; background:#200; padding:20px;">ERRO: ${e.message}</td></tr>`;
        pendingRequests.delete('agenda');
    });
}

function filterAgendaTable() {
    const input = document.getElementById('agenda-search');
    if (!input) return;
    const filter = input.value.toLowerCase();
    const rows = document.querySelectorAll('.agenda-row');

    rows.forEach(row => {
        const nameEl = row.querySelector('.client-name');
        const name = nameEl ? nameEl.innerText.toLowerCase() : row.innerText.toLowerCase();
        row.style.display = name.includes(filter) ? '' : 'none';
    });
}

function editAppt(id) {
    const appt = currentAgendaList.find(a => a.id === id);
    if (!appt) return alert('Erro: Agendamento não encontrado localmente.');

    document.getElementById('edit-appt-id').value = id;
    document.getElementById('edit-appt-name').value = appt.nome || '';
    document.getElementById('edit-appt-health').value = appt.saude || '';
    document.getElementById('edit-appt-project').value = appt.projeto || '';
    
    openModal('modal-edit-appt');
}

function saveApptChanges(event) {
    const id = document.getElementById('edit-appt-id').value;
    const saude = document.getElementById('edit-appt-health').value;
    const projeto = document.getElementById('edit-appt-project').value;

    const btn = event && event.target ? event.target : null;
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Salvando...';
    }

    fetch(`${API_URL}/agendamentos/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ saude, projeto })
    })
    .then(res => res.json())
    .then(data => {
        if(data.success) {
            closeModal('modal-edit-appt');
            fetchFullAgenda();
        } else {
            alert('Erro ao salvar: ' + (data.error || 'Desconhecido'));
        }
    })
    .catch(e => alert('Erro na requisição: ' + e.message))
    .finally(() => {
        if (btn) { btn.disabled = false; btn.innerText = 'Salvar'; }
    });
}

// Debounce para evitar múltiplos cliques acidental
const debouncedUpdateStatus = debounce(function(id, status) {
    if(!confirm(`Mudar status para ${status}?`)) return;
    fetch(`${API_URL}/agendamentos/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
    }).then(() => fetchFullAgenda())
    .catch(e => console.error(e));
}, 300);

function updateApptStatus(id, status) {
    debouncedUpdateStatus(id, status);
}

const debouncedDeleteAppt = debounce(function(id) {
    if(!confirm('Excluir agendamento?')) return;
    fetch(`${API_URL}/agendamentos/${id}`, { method: 'DELETE' })
        .then(() => fetchFullAgenda())
        .catch(e => console.error(e));
}, 300);

function deleteAppt(id) {
    debouncedDeleteAppt(id);
}

// --- BLOCKED DAYS ---

function fetchBlockedDays() {
    fetch(`${API_URL}/bloqueios`)
    .then(res => res.json())
    .then(data => {
        const container = document.getElementById('blocked-days-container');
        container.innerHTML = '';
        if (!Array.isArray(data)) return;
        data.forEach(d => {
            // Check if it's a partial block
            let displayDate = '';
            let rawDate = d;
            let period = 'Dia Inteiro';

            if (d.includes('::')) {
                const parts = d.split('::');
                rawDate = parts[0];
                period = parts[1];
            }

            // Adjust timezone issue by appending time or using getUTCDate
            // Assuming date string is YYYY-MM-DD
            const dateObj = new Date(rawDate + 'T12:00:00'); 
            const dateFmt = dateObj.toLocaleDateString('pt-BR');
            
            const badgeText = period === 'Dia Inteiro' ? dateFmt : `${dateFmt} (${period})`;

            const el = document.createElement('div');
            el.className = 'block-badge';
            el.innerHTML = `${badgeText} ✕`;
            // Pass origin 'd' string for unblock, encode it inside unblock function
            el.onclick = () => unblockDate(d);
            container.appendChild(el);
        });
    })
    .catch(console.error);
}

function addBlockDate() {
    const date = document.getElementById('block-date-input').value;
    const period = document.getElementById('block-period-input').value;

    if(!date) return alert('Selecione uma data!');

    let payload = date;
    if (period !== 'all') {
        payload = `${date}::${period}`;
    }

    fetch(`${API_URL}/bloqueios`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ data: payload })
    })
    .then(res => res.json())
    .then(() => {
        document.getElementById('block-date-input').value = '';
        fetchBlockedDays();
        // Also refresh calendar if present? Admin doesn't have calendar view here though.
    });
}

function unblockDate(dateStr) {
    if(!confirm('Desbloquear esta data/período?')) return;
    // Encode the dateStr because it might contain '::'
    const encoded = encodeURIComponent(dateStr);
    fetch(`${API_URL}/bloqueios/${encoded}`, { method: 'DELETE' })
    .then(() => fetchBlockedDays());
}


// --- CLIENTS CRM ---

function fetchClients() {
    cancelPendingRequest('clients');
    const controller = new AbortController();
    pendingRequests.set('clients', controller);
    
    fetch(`${API_URL}/admin/clientes`, { signal: controller.signal })
    .then(res => res.json())
    .then(data => {
        const tbody = document.getElementById('clientes-list');
        const list = data.clientes || [];
        window.lastClientList = list;

        if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:#888;">Nenhum cliente cadastrado.</td></tr>';
            return;
        }
        
        // DocumentFragment para renderização eficiente
        const fragment = document.createDocumentFragment();
        
        list.forEach(c => {
            const contact = c.telefone || c.email || 'Sem contato';
            const notes = c.notas || 'Cliente regular';
            const tag = c.origem === 'manual' ? 'Manual' : 'Site';
            
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><span style="font-weight:bold; color:#fff;">${c.nome}</span></td>
                <td>${contact}</td>
                <td>
                    <span style="background:#222; padding:2px 6px; border-radius:4px; font-size:0.8rem; margin-right:5px;">${tag}</span>
                    <span style="color:#888; font-size:0.8rem;">${notes}</span>
                </td>
                <td>
                    <button class="action-btn" style="background:#222; color:#fff; border:none; border-radius:4px; padding:4px 10px; cursor:pointer; font-size:0.9rem;" onclick="openEditClientModal(${c.id}, event)">Editar</button>
                </td>
            `;
            fragment.appendChild(tr);
        });
        
        tbody.innerHTML = '';
        tbody.appendChild(fragment);
        pendingRequests.delete('clients');
    })
    .catch(e => {
        if (e.name === 'AbortError') return;
        console.error('Clients CRM Error:', e);
        document.getElementById('clientes-list').innerHTML = `<tr><td colspan="4" style="color:#ff4444;text-align:center;">Erro: ${e.message}</td></tr>`;
        pendingRequests.delete('clients');
    });
}

// Funções globais para edição de cliente
window.openEditClientModal = function(id, event) {
    const client = window.lastClientList?.find(c => c.id === id);
    if (!client) return alert('Cliente não encontrado.');
    // Cria modal simples
    let modal = document.getElementById('modal-edit-client');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'modal-edit-client';
        modal.style = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;';
        modal.innerHTML = `<div style="background:#111;padding:30px 25px;border-radius:10px;min-width:320px;max-width:90vw;">
            <h2 style='color:#fff;font-size:1.2rem;margin-bottom:15px;'>Editar Cliente</h2>
            <label style='color:#ccc;'>Nome:<br><input id='edit-client-nome' style='width:100%;margin-bottom:10px;background:#222;color:#fff;padding:5px;border:none;border-radius:4px;'></label><br>
            <label style='color:#ccc;'>Telefone:<br><input id='edit-client-telefone' style='width:100%;margin-bottom:10px;background:#222;color:#fff;padding:5px;border:none;border-radius:4px;'></label><br>
            <label style='color:#ccc;'>Email:<br><input id='edit-client-email' style='width:100%;margin-bottom:10px;background:#222;color:#fff;padding:5px;border:none;border-radius:4px;'></label><br>
            <label style='color:#ccc;'>Notas:<br><textarea id='edit-client-notas' style='width:100%;height:60px;background:#222;color:#fff;padding:5px;border:none;border-radius:4px;'></textarea></label><br>
            <div style='margin-top:15px;text-align:right;'>
                <button onclick='saveEditClient(${id}, event)' style='background:#0a0;color:#fff;padding:7px 18px;border:none;border-radius:4px;font-weight:bold;cursor:pointer;'>Salvar</button>
                <button onclick='closeEditClientModal()' style='background:#800;color:#fff;padding:7px 18px;border:none;border-radius:4px;margin-left:10px;cursor:pointer;'>Cancelar</button>
            </div>
        </div>`;
        document.body.appendChild(modal);
    }
    // Preenche campos
    document.getElementById('edit-client-nome').value = client.nome || '';
    document.getElementById('edit-client-telefone').value = client.telefone || '';
    document.getElementById('edit-client-email').value = client.email || '';
    document.getElementById('edit-client-notas').value = client.notas || '';
    modal.style.display = 'flex';
    pauseRefresh(true, 'edição de cliente');
};

window.closeEditClientModal = function() {
    const modal = document.getElementById('modal-edit-client');
    if (modal) modal.style.display = 'none';
    pauseRefresh(false);
};

window.saveEditClient = function(id, event) {
        const nome = document.getElementById('edit-client-nome').value;
        const telefone = document.getElementById('edit-client-telefone').value;
        const email = document.getElementById('edit-client-email').value;
        const notas = document.getElementById('edit-client-notas').value;
        
        const btn = event && event.target ? event.target : null;
        if (btn) {
            btn.disabled = true;
            btn.innerText = 'Salvando...';
        }
        
        fetch(`${API_URL}/admin/clientes/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, telefone, email, notas })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                alert('Cliente atualizado com sucesso!');
                closeEditClientModal();
                fetchClients();
            } else {
                alert('Erro ao atualizar cliente.');
            }
        })
        .catch(() => alert('Erro ao atualizar cliente.'))
        .finally(() => {
            if (btn) { btn.disabled = false; btn.innerText = 'Salvar'; }
        });
    }


// --- PORTFOLIO ---
// Only load this when clicking the tab to save bandwidth usually, but here is fine.

function fetchPortfolio() {
    fetch(`${API_URL}/portfolio`)
    .then(r => {
        if (!r.ok) throw new Error('Servidor retornou ' + r.status);
        return r.json();
    })
    .then(data => {
        // Se veio array direto, usa. Se veio objeto com error, trata.
        if (Array.isArray(data)) {
            currentPortfolio = data;
        } else if (data && data.error) {
            throw new Error(data.error);
        } else {
            currentPortfolio = [];
        }
        renderPortfolioGrid();
    })
    .catch(e => {
        console.error('Portfolio Error:', e);
        currentPortfolio = [];
        renderPortfolioGrid();
        document.getElementById('portfolio-grid').innerHTML += `<div style="color:orange; padding:10px;">⚠️ Erro ao carregar: ${e.message}</div>`;
    });
}

function renderPortfolioGrid() {
    const grid = document.getElementById('portfolio-grid');

    if (currentPortfolio.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:20px; color:#888;">Nenhum item no portfólio. Adicione um novo item acima.</div>';
        return;
    }

    // DocumentFragment para renderização eficiente
    const fragment = document.createDocumentFragment();
    
    currentPortfolio.forEach((item, idx) => {
        const homeChecked = item.exibirHome !== false ? 'checked' : '';
        const homeLabel = item.exibirHome !== false ? '🏠 Home + Portfólio' : '🖼️ Só Portfólio';
        const borderColor = item.exibirHome !== false ? '#004400' : '#333';
        
        const div = document.createElement('div');
        div.className = 'portfolio-item-edit';
        div.style.cssText = `background:#000; padding:10px; border:2px solid ${borderColor}; border-radius:8px;`;
        div.innerHTML = `
            <div style="height:120px; background:url('${item.url}') center/cover; margin-bottom:10px; border-radius:4px;"></div>
            <input type="text" value="${item.preco}" onfocus="pauseRefresh(true, 'editando portfolio')" onblur="pauseRefresh(false)" onchange="updatePortItem(${idx}, 'preco', this.value)" style="width:100%; margin-bottom:5px; background:#222; border:none; color:#fff; padding:5px;" placeholder="Preço">
            <input type="text" value="${item.desc}" onfocus="pauseRefresh(true, 'editando portfolio')" onblur="pauseRefresh(false)" onchange="updatePortItem(${idx}, 'desc', this.value)" style="width:100%; margin-bottom:8px; background:#222; border:none; color:#aaa; padding:5px;" placeholder="Descrição">
            <label style="display:flex; align-items:center; gap:6px; color:#aaa; font-size:0.8rem; margin-bottom:8px; cursor:pointer;">
                <input type="checkbox" ${homeChecked} onchange="toggleHomeDisplay(${idx}, this.checked)" onfocus="pauseRefresh(true, 'editando portfolio')" onblur="pauseRefresh(false)" style="accent-color:var(--neon-red); width:16px; height:16px;">
                <span id="home-label-${idx}">${homeLabel}</span>
            </label>
            <button onclick="removePortItem(${idx})" style="width:100%; background:#800; color:#fff; border:none; cursor:pointer; padding:5px; border-radius:4px;">Remover</button>
        `;
        fragment.appendChild(div);
    });
    
    grid.innerHTML = '';
    grid.appendChild(fragment);
}

function toggleHomeDisplay(idx, checked) {
    currentPortfolio[idx].exibirHome = checked;
    renderPortfolioGrid();
}

function updatePortItem(idx, field, val) {
    currentPortfolio[idx][field] = val;
}

function removePortItem(idx) {
    if(confirm('Remover?')) {
        currentPortfolio.splice(idx, 1);
        renderPortfolioGrid();
        savePortfolioChanges(); // Salvar imediatamente ao deletar
    }
}

// Upload com compressão de imagem
function confirmAddPortfolio() {
    const fileInput = document.getElementById('port-file-input');
    const preco = document.getElementById('port-price-input').value.trim();
    const desc = document.getElementById('port-desc-input').value.trim();

    if (fileInput.files.length === 0) return alert('Selecione uma imagem.');
    const file = fileInput.files[0];

    // Validar tipo de arquivo
    if (!file.type.startsWith('image/')) return alert('Selecione um arquivo de imagem válido (JPG, PNG, etc).');

    // Limite 10MB original
    if (file.size > 10 * 1024 * 1024) return alert('A imagem deve ter no máximo 10MB.');

    // Comprimir imagem via canvas
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = function() { alert('Erro ao ler o arquivo.'); };
    reader.onload = function(e) {
        img.onerror = function() { alert('Arquivo não é uma imagem válida.'); };
        img.onload = function() {
            try {
                const canvas = document.createElement('canvas');
                const MAX_SIZE = 800;
                let w = img.width;
                let h = img.height;
                if (w > h) {
                    if (w > MAX_SIZE) { h = Math.round(h * MAX_SIZE / w); w = MAX_SIZE; }
                } else {
                    if (h > MAX_SIZE) { w = Math.round(w * MAX_SIZE / h); h = MAX_SIZE; }
                }
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (!ctx) { alert('Erro ao processar imagem (canvas).'); return; }
                ctx.drawImage(img, 0, 0, w, h);
                const compressed = canvas.toDataURL('image/jpeg', 0.65);

                // Verificar se a imagem comprimida não é muito grande (max ~500KB por foto)
                const imgSizeKB = Math.round(compressed.length / 1024);
                if (imgSizeKB > 800) {
                    alert('Imagem ainda ficou grande após compressão (' + imgSizeKB + 'KB). Tente uma imagem menor.');
                    return;
                }

                currentPortfolio.push({
                    id: Date.now(),
                    url: compressed,
                    preco: preco || 'R$ Sob Consulta',
                    desc: desc || 'Tatuagem Personalizada',
                    exibirHome: document.getElementById('port-home-check').checked
                });

                savePortfolioChanges();
                closeModal('modal-add-portfolio');
                fileInput.value = '';
                document.getElementById('port-price-input').value = '';
                document.getElementById('port-desc-input').value = '';
                renderPortfolioGrid();
            } catch(err) {
                alert('Erro ao comprimir imagem: ' + err.message);
            }
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

const debouncedSavePortfolio = debounce(function() {
    // Validar cada item antes de enviar
    for (let i = 0; i < currentPortfolio.length; i++) {
        const item = currentPortfolio[i];
        if (!item.id) item.id = Date.now() + i;
        if (!item.url || typeof item.url !== 'string') {
            alert('Item ' + (i+1) + ' sem imagem válida. Removendo...');
            currentPortfolio.splice(i, 1);
            i--;
            continue;
        }
        if (!item.preco) item.preco = 'R$ Sob Consulta';
        if (!item.desc) item.desc = 'Tatuagem';
        if (typeof item.exibirHome === 'undefined') item.exibirHome = true;
    }

    const payload = JSON.stringify({ items: currentPortfolio });
    const sizeMB = (payload.length / (1024 * 1024)).toFixed(2);
    
    if (payload.length > 20 * 1024 * 1024) {
        alert('Portfólio muito grande (' + sizeMB + 'MB). Remova algumas fotos.');
        return;
    }

    const statusEl = document.createElement('div');
    statusEl.id = 'save-status';
    statusEl.style.cssText = 'position:fixed;top:20px;right:20px;background:#FF6600;color:#fff;padding:15px 25px;border-radius:6px;z-index:10000;';
    statusEl.innerText = '⏳ Salvando...';
    document.body.appendChild(statusEl);

    fetch(`${API_URL}/portfolio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
    })
    .then(r => {
        if (!r.ok) {
            return r.json().then(data => {
                throw new Error(data.error || 'Erro ' + r.status);
            }).catch(() => { throw new Error('Erro do servidor: ' + r.status); });
        }
        return r.json();
    })
    .then(() => {
        statusEl.style.background = '#00AA00';
        statusEl.innerText = '✅ Portfólio salvo! (' + sizeMB + 'MB)';
        setTimeout(() => statusEl.remove(), 3000);
    })
    .catch(err => {
        statusEl.style.background = '#AA0000';
        statusEl.innerText = '❌ Erro ao salvar: ' + err.message;
        setTimeout(() => statusEl.remove(), 5000);
    });
}, 1500);

function savePortfolioChanges() {
    debouncedSavePortfolio();
}

function clearAllPortfolio() {
    if (!confirm('Tem certeza que deseja apagar TODAS as fotos do portfólio?')) return;
    fetch(`${API_URL}/portfolio`, { method: 'DELETE' })
    .then(r => r.json())
    .then(() => {
        currentPortfolio = [];
        renderPortfolioGrid();
        alert('Portfólio limpo!');
    })
    .catch(err => alert('Erro: ' + err.message));
}

// --- MANUAL CONTROLS & MODALS ---

function openModal(modalId) {
    const el = document.getElementById(modalId);
    if(el) el.classList.add('open');
    pauseRefresh(true, 'modal aberto');
}

function closeModal(modalId) {
    const el = document.getElementById(modalId);
    if(el) el.classList.remove('open');
    pauseRefresh(false);
}

// 1. Dashboard Manual updates
function updateManualStat(action) {
    let value = null;
    
    if (action === 'addRevenue') value = parseFloat(document.getElementById('manual-rev-input').value.replace(',', '.'));
    if (action === 'addReservation') value = parseFloat(document.getElementById('manual-res-input').value.replace(',', '.'));
    if (action === 'setSlots') value = parseInt(document.getElementById('manual-slots-input').value, 10);
    if (action === 'resetSlots') { action = 'setSlots'; value = -1; }

    if ((value === null || Number.isNaN(value)) && action !== 'setSlots') return alert('Digite um valor válido.');

    fetch(`${API_URL}/admin/dashboard/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, value })
    })
    .then(res => res.json())
    .then(data => {
        // Clear inputs
        if(document.getElementById('manual-rev-input')) document.getElementById('manual-rev-input').value = '';
        if(document.getElementById('manual-res-input')) document.getElementById('manual-res-input').value = '';
        if(document.getElementById('manual-slots-input')) document.getElementById('manual-slots-input').value = '';

        refreshAll(); // Reload dashboard
    })
    .catch(err => alert('Erro ao atualizar.'));
}

// 2. Manual Appointment
function submitManualAppt() {
    const nome = document.getElementById('manual-appt-name').value;
    const data = document.getElementById('manual-appt-date').value;
    const periodo = document.getElementById('manual-appt-period').value;
    const tipo = parseInt(document.getElementById('manual-appt-type').value);
    const valor = document.getElementById('manual-appt-val').value;

    if(!nome || !data) return alert('Nome e Data são obrigatórios.');

    fetch(`${API_URL}/admin/agendamentos/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            nome, data, periodo, tipo, 
            valor: valor ? parseFloat(valor) : null,
            status: 'Confirmado' // Manual entry usually means confirmed on spot
        })
    })
    .then(res => {
        if(!res.ok) throw new Error();
        return res.json();
    })
    .then(data => {
        alert('Agendamento manual criado!');
        closeModal('modal-add-appt');
        refreshAll(); // Update Agenda List
        // Clear inputs
        document.getElementById('manual-appt-name').value = '';
        document.getElementById('manual-appt-date').value = '';
    })
    .catch(() => alert('Erro ao criar agendamento.'));
}

// 3. New Client Manual
function submitNewClient() {
    const nome = document.getElementById('new-client-name').value;
    const telefone = document.getElementById('new-client-phone').value;
    const email = document.getElementById('new-client-email').value;
    const notas = document.getElementById('new-client-notes').value;

    if(!nome) return alert('Nome do cliente é obrigatório.');

    fetch(`${API_URL}/admin/clientes/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome, telefone, email, notas })
    })
    .then(res => res.json())
    .then(data => {
        alert('Cliente cadastrado com sucesso!');
        closeModal('modal-add-client');
        fetchClients(); // Update Client List
        // Clear
        document.getElementById('new-client-name').value = '';
        document.getElementById('new-client-phone').value = '';
        document.getElementById('new-client-email').value = '';
    })
    .catch(() => alert('Erro ao cadastrar cliente.'));
}

// Ensure Portfolio is loaded if it's the first view (unlikely, but safe)
document.addEventListener('DOMContentLoaded', () => {
   // Switch default view
   switchView('dashboard');
});

// CONFIG TEXTOS
function fetchConfig() {
    fetch(`${API_URL}/config`) // Note: Using public /api/config which allows GET
    .then(res => res.json())
    .then(data => {
        if(data.dicas) document.getElementById('config-dicas-input').value = data.dicas;
        if(data.info) document.getElementById('config-info-input').value = data.info;
        if(data.label_type1) document.getElementById('config-type1-input').value = data.label_type1;
        if(data.label_type2) document.getElementById('config-type2-input').value = data.label_type2;
        if(data.label_type3) document.getElementById('config-type3-input').value = data.label_type3;
        if(data.label_health) document.getElementById('config-health-input').value = data.label_health;
        if(data.label_project) document.getElementById('config-project-input').value = data.label_project;
        if(data.form_title) document.getElementById('config-form-title-input').value = data.form_title;
        if(data.label_taxa) document.getElementById('config-taxa-input').value = data.label_taxa;
        if(data.label_btn_confirm) document.getElementById('config-btn-confirm-input').value = data.label_btn_confirm;
        if(data.whatsapp) document.getElementById('config-whatsapp-input').value = data.whatsapp;
    });
}

function saveConfigTextos() {
    const btn = document.querySelector('button[onclick="saveConfigTextos()"]');
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Salvando...';
    }

    const dicas = document.getElementById('config-dicas-input').value;
    const info = document.getElementById('config-info-input').value;
    const label_type1 = document.getElementById('config-type1-input').value;
    const label_type2 = document.getElementById('config-type2-input').value;
    const label_type3 = document.getElementById('config-type3-input').value;
    const label_health = document.getElementById('config-health-input').value;
    const label_project = document.getElementById('config-project-input').value;
    const form_title = document.getElementById('config-form-title-input').value;
    const label_taxa = document.getElementById('config-taxa-input').value;
    const label_btn_confirm = document.getElementById('config-btn-confirm-input').value;
    const whatsapp = document.getElementById('config-whatsapp-input').value;

    fetch(`${API_URL}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            dicas, 
            info,
            label_type1,
            label_type2,
            label_type3,
            label_health,
            label_project,
            form_title,
            label_taxa,
            label_btn_confirm,
            whatsapp
        }) 
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) alert('Configurações salvas!');
        else alert('Erro ao salvar.');
    })
    .catch(() => alert('Erro de conexão.'))
    .finally(() => {
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'SALVAR TUDO';
        }
    });
}

// --- DEPLOY ---
function startDeploy() {
    const btn = document.getElementById('btn-deploy');
    const statusBox = document.getElementById('deploy-status');
    const indicator = document.getElementById('deploy-indicator');
    const statusText = document.getElementById('deploy-status-text');
    const logEl = document.getElementById('deploy-log');

    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.innerText = 'PUBLICANDO...';
    statusBox.style.display = 'block';
    indicator.style.background = '#ffaa00';
    statusText.innerText = 'Deploy em andamento...';
    logEl.innerText = 'Iniciando deploy para Cloudflare Pages...\n';

    fetch(`${API_URL}/admin/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            indicator.style.background = '#00ff00';
            statusText.innerText = 'Deploy concluído com sucesso!';
            logEl.innerText += 'Deploy realizado com sucesso.\n';
            if (data.url) logEl.innerText += 'URL: ' + data.url + '\n';
        } else {
            indicator.style.background = '#ff0000';
            statusText.innerText = 'Erro no deploy';
            logEl.innerText += 'Erro: ' + (data.error || 'Falha desconhecida') + '\n';
        }
    })
    .catch(err => {
        indicator.style.background = '#ff0000';
        statusText.innerText = 'Erro de conexão';
        logEl.innerText += 'Erro: ' + err.message + '\nDica: Execute o deploy manualmente via terminal com:\n  npx wrangler pages deploy frontend\n';
    })
    .finally(() => {
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/><polyline points="16 16 12 12 8 16"/></svg> DEPLOY PARA CLOUDFLARE';
    });
}
// Expose globally
window.startDeploy = startDeploy;

// === PRODUTOS MANAGEMENT (localStorage) ===
let productsList = JSON.parse(localStorage.getItem('dizzy_products') || '[]');

function saveProducts() {
    localStorage.setItem('dizzy_products', JSON.stringify(productsList));
}

function loadProducts() {
    productsList = JSON.parse(localStorage.getItem('dizzy_products') || '[]');
    renderProductStats();
    renderProductTable();
}

function renderProductStats() {
    document.getElementById('prod-total').innerText = productsList.length;
    const cats = new Set(productsList.map(p => p.cat));
    document.getElementById('prod-cats').innerText = cats.size || 0;
    const avg = productsList.length > 0
        ? (productsList.reduce((s, p) => s + (p.price || 0), 0) / productsList.length).toFixed(2)
        : '0';
    document.getElementById('prod-avg').innerText = 'R$ ' + avg.replace('.', ',');
}

function renderProductTable() {
    const tbody = document.getElementById('produtos-list');
    const search = (document.getElementById('prod-search')?.value || '').toLowerCase();
    let items = productsList;
    if (search) items = items.filter(p => p.name.toLowerCase().includes(search));

    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#555;">Nenhum produto cadastrado.</td></tr>';
        return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach((p, idx) => {
        const tr = document.createElement('tr');
        const catLabel = { masculino: 'Masc', feminino: 'Fem', unissex: 'Uni' }[p.cat] || p.cat;
        const sizesHtml = (p.sizes || []).map(s => `<span style="background:#222; padding:2px 6px; border-radius:4px; font-size:0.75rem; margin-right:3px;">${s}</span>`).join('');
        tr.className = 'prod-row';
        tr.innerHTML = `
            <td><span style="font-weight:bold; color:#fff;">${p.name}</span></td>
            <td>R$ ${(p.price || 0).toFixed(2).replace('.', ',')}</td>
            <td><span style="background:#222; padding:2px 8px; border-radius:4px; font-size:0.8rem;">${catLabel}</span></td>
            <td>${sizesHtml}</td>
            <td>
                <button onclick="deleteProduct(${p.id})" style="background:#800; color:#fff; border:none; border-radius:4px; padding:6px 12px; cursor:pointer; min-width:44px; min-height:44px; font-weight:bold;">✖</button>
            </td>
        `;
        fragment.appendChild(tr);
    });
    tbody.innerHTML = '';
    tbody.appendChild(fragment);
}

function filterProductTable() {
    renderProductTable();
}

function addProduct() {
    const name = document.getElementById('prod-name').value.trim();
    const price = parseFloat(document.getElementById('prod-price').value);
    const cat = document.getElementById('prod-cat').value;
    const sizesRaw = document.getElementById('prod-sizes').value.trim();
    const fileInput = document.getElementById('prod-img');

    if (!name) return alert('Informe o nome do produto.');
    if (isNaN(price) || price <= 0) return alert('Informe um preço válido.');

    const sizes = sizesRaw ? sizesRaw.split(',').map(s => s.trim()).filter(Boolean) : ['Único'];

    function finishAdd(imgUrl) {
        productsList.push({
            id: Date.now(),
            name: name,
            price: price,
            cat: cat,
            sizes: sizes,
            img: imgUrl || 'img/products/tshirt_skull.png',
            createdAt: new Date().toISOString()
        });
        saveProducts();
        loadProducts();

        // Clear form
        document.getElementById('prod-name').value = '';
        document.getElementById('prod-price').value = '';
        document.getElementById('prod-sizes').value = '';
        if (fileInput) fileInput.value = '';
    }

    // If image file selected, compress and store as data URL
    if (fileInput && fileInput.files.length > 0) {
        const file = fileInput.files[0];
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
                const canvas = document.createElement('canvas');
                const MAX = 400;
                let w = img.width, h = img.height;
                if (w > h) { if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; } }
                else { if (h > MAX) { w = Math.round(w * MAX / h); h = MAX; } }
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                finishAdd(canvas.toDataURL('image/jpeg', 0.6));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    } else {
        finishAdd('');
    }
}

function deleteProduct(id) {
    if (!confirm('Remover este produto?')) return;
    productsList = productsList.filter(p => p.id !== id);
    saveProducts();
    loadProducts();
}

// Expose
window.addProduct = addProduct;
window.deleteProduct = deleteProduct;
window.filterProductTable = filterProductTable;


// === VENDAS MANAGEMENT (localStorage) ===
let salesList = JSON.parse(localStorage.getItem('dizzy_sales') || '[]');

function saveSales() {
    localStorage.setItem('dizzy_sales', JSON.stringify(salesList));
}

function loadSales() {
    salesList = JSON.parse(localStorage.getItem('dizzy_sales') || '[]');
    renderSalesStats();
    renderSalesTable();
}

function renderSalesStats() {
    const now = new Date();
    const monthSales = salesList.filter(s => {
        const d = new Date(s.date);
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    const total = monthSales.reduce((s, v) => s + (v.valor || 0), 0);
    const count = monthSales.length;
    const ticket = count > 0 ? (total / count) : 0;

    document.getElementById('vendas-mes').innerText = 'R$ ' + total.toFixed(2).replace('.', ',');
    document.getElementById('vendas-pedidos').innerText = count;
    document.getElementById('vendas-ticket').innerText = 'R$ ' + ticket.toFixed(2).replace('.', ',');
}

function renderSalesTable() {
    const tbody = document.getElementById('vendas-list');
    const filterVal = document.getElementById('vendas-filter')?.value || 'all';
    const search = (document.getElementById('vendas-search')?.value || '').toLowerCase();

    let items = salesList.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    if (filterVal !== 'all') items = items.filter(s => s.status === filterVal);
    if (search) items = items.filter(s =>
        (s.cliente || '').toLowerCase().includes(search) ||
        (s.produto || '').toLowerCase().includes(search)
    );

    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:20px; color:#555;">Nenhuma venda encontrada.</td></tr>';
        return;
    }

    const statusColors = { 'Pago': '#0f0', 'Pendente': 'orange', 'Enviado': '#0af', 'Entregue': '#888' };
    const fragment = document.createDocumentFragment();
    items.forEach(s => {
        const tr = document.createElement('tr');
        const dateFmt = new Date(s.date).toLocaleDateString('pt-BR');
        const color = statusColors[s.status] || '#aaa';
        tr.innerHTML = `
            <td>${dateFmt}</td>
            <td><span style="font-weight:bold; color:#fff;">${s.cliente}</span></td>
            <td>${s.produto}</td>
            <td>R$ ${(s.valor || 0).toFixed(2).replace('.', ',')}</td>
            <td><span style="background:#222; padding:2px 8px; border-radius:4px; font-size:0.8rem;">${s.canal}</span></td>
            <td><span style="color:${color}; border:1px solid ${color}; padding:2px 8px; border-radius:4px; font-size:0.8rem;">${s.status}</span></td>
            <td>
                <button onclick="deleteSale(${s.id})" style="background:#800; color:#fff; border:none; border-radius:4px; padding:6px 12px; cursor:pointer; min-width:44px; min-height:44px; font-weight:bold;">✖</button>
            </td>
        `;
        fragment.appendChild(tr);
    });
    tbody.innerHTML = '';
    tbody.appendChild(fragment);
}

function addSale() {
    const cliente = document.getElementById('venda-cliente').value.trim();
    const produto = document.getElementById('venda-produto').value.trim();
    const valor = parseFloat(document.getElementById('venda-valor').value);
    const canal = document.getElementById('venda-canal').value;
    const status = document.getElementById('venda-status').value;

    if (!cliente) return alert('Informe o nome do cliente.');
    if (!produto) return alert('Informe o produto.');
    if (isNaN(valor) || valor <= 0) return alert('Informe um valor válido.');

    salesList.push({
        id: Date.now(),
        cliente, produto, valor, canal, status,
        date: new Date().toISOString()
    });
    saveSales();
    loadSales();

    // Clear form
    document.getElementById('venda-cliente').value = '';
    document.getElementById('venda-produto').value = '';
    document.getElementById('venda-valor').value = '';
}

function deleteSale(id) {
    if (!confirm('Remover esta venda?')) return;
    salesList = salesList.filter(s => s.id !== id);
    saveSales();
    loadSales();
}

// Expose
window.addSale = addSale;
window.deleteSale = deleteSale;
window.renderSalesTable = renderSalesTable;

