// CONFIGURAÇÃO
// Se estiver rodando localmente (dev), use localhost. Se for produção (Cloudflare), use caminho relativo (Pages Functions).
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
// Em produção, usa a mesma origem /api (Cloudflare Pages Functions)
const API_URL = isLocal
    ? 'http://localhost:3001/api'
    : '/api';

const NUM_DAYS = 14;
let CARD_WIDTH = 190; // será atualizado via JS
let currentIndex = 0;
let daysList = [];
let blockedDays = [];

// ELEMENTOS DOM
const track = document.getElementById('carousel-track');
const prevBtn = document.getElementById('carousel-prev');
const nextBtn = document.getElementById('carousel-next');

// Ajustar largura do card baseado na tela (Responsividade iPhone)
function updateCardDimensions() {
    const isMobile = window.innerWidth <= 600;
    // Mobile: Card mais largo (ex: 240px) + Gap (20px) = 260
    // Desktop: 170px + 20px = 190
    
    // Atualiza variavel JS
    CARD_WIDTH = isMobile ? 260 : 190;
    
    // Atualiza CSS via variável CSS no root para sincronia
    document.documentElement.style.setProperty('--card-width', isMobile ? '240px' : '170px');
    
    updateCarouselPosition();
}
window.addEventListener('resize', updateCardDimensions);
// Chama inicialização logo após carregar
setTimeout(updateCardDimensions, 100);

// FUNÇÕES DE API
async function fetchConfig() {
    try {
        const res = await fetch(`${API_URL}/config?_t=${Date.now()}`);
        const data = await res.json();
        
        if(data.dicas) {
            const el = document.getElementById('booking-tips-text');
            if(el) el.innerText = data.dicas;
        }

        // TIPOS DE TATUAGEM
        if(data.label_type1) {
            const el = document.getElementById('opt-type-1');
            if(el) el.innerText = data.label_type1;
        }
        if(data.label_type2) {
            const el = document.getElementById('opt-type-2');
            if(el) el.innerText = data.label_type2;
        }
        // Tipo 3 (opcional)
        if(data.label_type3 && data.label_type3.trim() !== '') {
            const select = document.getElementById('job-type');
            if(select && !document.getElementById('opt-type-3')) {
                const opt = document.createElement('option');
                opt.value = '3';
                opt.id = 'opt-type-3';
                opt.innerText = data.label_type3;
                select.appendChild(opt);
            } else if(document.getElementById('opt-type-3')) {
                document.getElementById('opt-type-3').innerText = data.label_type3;
            }
        }

        // LABELS DO FORMULÁRIO
        if(data.label_health) {
             const el = document.getElementById('client-health');
             if(el) el.placeholder = data.label_health;
        }
        if(data.label_project) {
             const el = document.getElementById('client-project');
             if(el) el.placeholder = data.label_project;
        }
        if(data.form_title) {
             const el = document.getElementById('form-title');
             if(el) el.innerText = data.form_title;
        }
        if(data.label_taxa) {
             const el = document.getElementById('taxa-text');
             if(el) el.innerHTML = data.label_taxa;
        }
        if(data.label_btn_confirm) {
             const el = document.getElementById('btn-confirm-booking');
             if(el) el.innerText = data.label_btn_confirm;
        }

    } catch(e) { console.error('Erro config', e); }
}

async function fetchBlockedDays() {
    try {
        const res = await fetch(`${API_URL}/bloqueios`);
        blockedDays = await res.json();
    } catch (e) {
        console.error('Erro ao buscar bloqueios', e);
        // Fallback para evitar travamento: inicializar array vazio
        blockedDays = [];
    }
}

async function fetchPortfolio() {
    try {
        const res = await fetch(`${API_URL}/portfolio`);
        const data = await res.json();
        renderPortfolio(data);
    } catch(e) { console.error('Erro ao carregar portfolio', e); }
}

function renderPortfolio(items) {
    const pTrack = document.querySelector('.portfolio-track');
    if(!pTrack) return;
    pTrack.innerHTML = '';
    
    if(!Array.isArray(items)) return;

    // Filtra apenas itens marcados para exibir na home
    const homeItems = items.filter(item => item.exibirHome !== false);

    // Store for lightbox access
    window._portfolioItems = homeItems;

    homeItems.forEach((item, idx) => {
        const card = document.createElement('div');
        card.className = 'portfolio-card';
        card.innerHTML = `
             <div class="portfolio-img" style="background-image:url('${item.url}')"></div>
             <div class="portfolio-info">
                <span class="price-tag">${item.preco}</span>
                <span class="desc-tag">${item.desc}</span>
             </div>
        `;
        card.addEventListener('click', () => openLightbox(homeItems, idx));
        pTrack.appendChild(card);
    });
}

// === LIGHTBOX CAROUSEL LOGIC ===
(function() {
    let lbItems = [];
    let lbIndex = 0;
    let lbTouchStartX = 0;
    let lbTouchEndX = 0;

    const overlay = document.getElementById('portfolio-lightbox');
    if (!overlay) return; // Lightbox not present on this page

    const track = document.getElementById('lb-track');
    const counter = document.getElementById('lb-counter');
    const priceEl = document.getElementById('lb-price');
    const descEl = document.getElementById('lb-desc');
    const closeBtn = document.getElementById('lb-close');
    const prevBtn = document.getElementById('lb-prev');
    const nextBtn = document.getElementById('lb-next');
    const wrapper = overlay.querySelector('.lightbox-image-wrapper');

    function buildSlides(items) {
        track.innerHTML = '';
        items.forEach(item => {
            const slide = document.createElement('div');
            slide.className = 'lightbox-slide';
            const img = document.createElement('img');
            img.src = item.url;
            img.alt = item.desc || 'Dizzy House Studio';
            img.draggable = false;
            slide.appendChild(img);
            track.appendChild(slide);
        });
    }

    function updateLightbox() {
        track.style.transform = `translateX(-${lbIndex * 100}%)`;
        counter.textContent = `${lbIndex + 1} / ${lbItems.length}`;
        
        const item = lbItems[lbIndex];
        if (item) {
            priceEl.textContent = item.preco || '';
            descEl.textContent = item.desc || '';
        }

        // Arrow visibility
        prevBtn.style.opacity = lbIndex === 0 ? '0.3' : '1';
        prevBtn.style.pointerEvents = lbIndex === 0 ? 'none' : 'auto';
        nextBtn.style.opacity = lbIndex === lbItems.length - 1 ? '0.3' : '1';
        nextBtn.style.pointerEvents = lbIndex === lbItems.length - 1 ? 'none' : 'auto';
    }

    window.openLightbox = function(items, startIndex) {
        lbItems = items;
        lbIndex = startIndex || 0;
        buildSlides(items);
        updateLightbox();

        overlay.style.display = 'flex';
        // Force reflow for transition
        overlay.offsetHeight;
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    };

    function closeLightbox() {
        overlay.classList.remove('active');
        setTimeout(() => {
            overlay.style.display = 'none';
            document.body.style.overflow = '';
        }, 350);
    }

    function lbPrev() {
        if (lbIndex > 0) {
            lbIndex--;
            updateLightbox();
        }
    }

    function lbNext() {
        if (lbIndex < lbItems.length - 1) {
            lbIndex++;
            updateLightbox();
        }
    }

    // Event listeners
    closeBtn.addEventListener('click', closeLightbox);
    prevBtn.addEventListener('click', lbPrev);
    nextBtn.addEventListener('click', lbNext);

    // Click backdrop to close
    overlay.querySelector('.lightbox-backdrop').addEventListener('click', closeLightbox);

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        if (overlay.style.display !== 'flex') return;
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowLeft') lbPrev();
        if (e.key === 'ArrowRight') lbNext();
    });

    // Touch/Swipe on lightbox
    if (wrapper) {
        wrapper.addEventListener('touchstart', (e) => {
            lbTouchStartX = e.changedTouches[0].screenX;
        }, { passive: true });

        wrapper.addEventListener('touchend', (e) => {
            lbTouchEndX = e.changedTouches[0].screenX;
            const diff = lbTouchEndX - lbTouchStartX;
            const threshold = 50;
            if (diff < -threshold) lbNext();
            else if (diff > threshold) lbPrev();
        }, { passive: true });
    }
})();


// FUNÇÕES DE AGENDAMENTO
async function reservarHorario(nome, data, periodo, tipo, saude, projeto) {
    try {
        const res = await fetch(`${API_URL}/agendar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, data, periodo, tipo, saude, projeto })
        });
        return res.ok;
    } catch (e) {
        console.error("Erro ao reservar:", e);
        return false;
    }
}

async function cadastrarCliente(nome) {
    try {
        const res = await fetch(`${API_URL}/clientes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome })
        });
        return res.ok;
    } catch (e) { console.error(e); return false; }
}

// LÓGICA DO CALENDÁRIO
function gerarDias() {
    const today = new Date();
    daysList = [];

    // ADICIONADO: Cartão inicial para Agendamento de Urgência
    daysList.push({ isUrgent: true });

    for (let i = 0; i < NUM_DAYS; i++) {
        const date = new Date();
        date.setDate(today.getDate() + i);
        
        // Ajuste de fuso horário local: Usar componentes locais para evitar UTC offset
        // const dateStr = date.toISOString().split('T')[0]; // ISSO CAUSA ERRO DE FUSO NO FINAL DO DIA
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${day}`;
        
        const dayName = date.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
        const dayNum = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        const isSunday = date.getDay() === 0;
        
        // Bloqueio de antecedência mínima (ex: 2 dias)
        // Se hoje é dia 10, i=0 é dia 10. i=1 dia 11. i=2 dia 12.
        // Permitir agendar a partir de i=2 (3º dia)
        const isTooSoon = i < 2; 
        const isFullDayBlocked = blockedDays.includes(dateStr);

        // ATUALIZAÇÃO: Domingo agora é permitido, mas terá destaque visual
        const isBlocked = isTooSoon || isFullDayBlocked;

        const partialBlocks = {
             manha: blockedDays.includes(`${dateStr}::Manhã`),
             tarde: blockedDays.includes(`${dateStr}::Tarde`),
             noite: blockedDays.includes(`${dateStr}::Noite`)
        };
        
        // Bloqueios por horário individual (ex: "2026-03-05::14h")
        const hourBlocks = {};
        blockedDays.forEach(b => {
            if (b.startsWith(`${dateStr}::`) && b.match(/::\d+h$/)) {
                const hour = b.split('::')[1];
                hourBlocks[hour] = true;
            }
        });

        daysList.push({ 
            dateStr, 
            dayName, 
            dayNum, 
            isBlocked, 
            partialBlocks,
            hourBlocks,
            index: i, 
            blockedReason: isFullDayBlocked ? 'FECHADO' : (isTooSoon ? 'INDISPONÍVEL' : ''),
            isSunday: isSunday // Passando flag de domingo
        });
    }
    
    // ADICIONADO: Cartão final explicativo para WhatsApp
    daysList.push({ isInfo: true });

    // ADICIONADO: Selecionar horários aleatórios para destaque (sugestão)
    let availableSlots = [];
    daysList.forEach((d, dIdx) => {
        if (d.isBlocked || d.isUrgent || d.isInfo) return;
        d.suggestedHours = {}; // Initialize
        if (d.isSunday) {
            ['11h', '14h', '15h'].forEach(h => { if (!d.hourBlocks[h]) availableSlots.push({dIdx, h}); });
        } else {
            if (!d.partialBlocks.manha) ['8h', '9h', '10h', '11h'].forEach(h => { if (!d.hourBlocks[h]) availableSlots.push({dIdx, h}); });
            if (!d.partialBlocks.tarde) ['14h', '15h', '16h'].forEach(h => { if (!d.hourBlocks[h]) availableSlots.push({dIdx, h}); });
            if (!d.partialBlocks.noite) ['17h', '18h', '19h', '20h'].forEach(h => { if (!d.hourBlocks[h]) availableSlots.push({dIdx, h}); });
        }
    });

    availableSlots.sort(() => Math.random() - 0.5);
    let suggestions = [];
    for (let slot of availableSlots) {
        if (suggestions.length >= 3) break;
        // Garantir espaçamento de pelo menos 2 dias entre sugestões
        if (!suggestions.some(s => Math.abs(s.dIdx - slot.dIdx) < 2)) {
            suggestions.push(slot);
        }
    }
    suggestions.forEach(s => {
        daysList[s.dIdx].suggestedHours[s.h] = true;
    });
}

function renderCarousel() {
    if(!track) return;
    track.innerHTML = '';
    daysList.forEach((d) => {
        const card = document.createElement('div');
        card.className = 'date-card';

        // Lógica do card especial de Urgência (Início da lista)
        if (d.isUrgent) {
            card.style.borderColor = 'var(--neon-red)';
            card.style.boxShadow = '0 0 10px rgba(255, 0, 0, 0.2)';
            
            card.innerHTML = `
                <div style="color:#ffcc00; filter: drop-shadow(0 0 8px #ffcc00); margin-bottom:10px;">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor">
                         <path d="M13 14H11V9H13M13 18H11V16H13M1 21H23L12 2L1 21Z" />
                    </svg>
                </div>
                <div class="day-name" style="font-size:1.1rem; font-family:'Roboto'; margin-bottom:5px;">URGÊNCIA</div>
                <div style="font-size:0.8rem; color:#aaa; margin-bottom:15px; line-height:1.4;">
                    Precisa de um horário<br>para agora?
                </div>
                <a href="https://wa.me/5521976265417?text=Oi,%20gostaria%20de%20verificar%20vaga%20com%20urgência!" target="_blank" class="slot-btn" style="color:#00ff00; border-color:#00ff00; text-shadow: 0 0 5px #00ff00; box-shadow: 0 0 8px rgba(0, 255, 0, 0.4); text-decoration:none; display:flex; align-items:center; justify-content:center;">CHAMAR AGORA</a>
            `;
            track.appendChild(card);
            return;
        }

        // Lógica do card especial de informação (Fim da lista)
        if (d.isInfo) {
            card.style.borderColor = '#25d366';
            card.style.boxShadow = '0 0 10px rgba(37, 211, 102, 0.2)';
            
            card.innerHTML = `
                <div style="color:#25d366; margin-bottom:10px;">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471.148-.67.445-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
                    </svg>
                </div>
                <div class="day-name" style="font-size:1.1rem; font-family:'Roboto'; margin-bottom:5px;">Agenda Futura</div>
                <div style="font-size:0.8rem; color:#aaa; margin-bottom:15px; line-height:1.4;">
                    Datas além de 14 dias?<br>Fale diretamente.
                </div>
                <a href="https://wa.me/5521976265417?text=Ol%C3%A1!%20Gostaria%20de%20agendar%20uma%20tatuagem%20para%20uma%20data%20futura." target="_blank" class="slot-btn" style="color:#25d366; border-color:#25d366; text-decoration:none; display:flex; align-items:center; justify-content:center;">CHAMAR NO ZAP</a>
            `;
            track.appendChild(card);
            return;
        }

        // Estilo especial para Domingos (Exclusivo/Raro)
        if (d.isSunday && !d.isBlocked) {
            // Neon roxo premium
            card.style.border = '1px solid #aa00ff'; 
            card.style.boxShadow = '0 0 15px rgba(170, 0, 255, 0.6)';
            card.style.background = 'linear-gradient(180deg, rgba(20,20,20,1) 0%, rgba(30,0,40,1) 100%)';
        }

        if (!d.isBlocked) {
            // Adicionar event listener para destacar o card ao clicar em algum botão
        } else {
            card.style.opacity = '0.4';
            card.style.borderColor = '#300';
            card.style.background = '#0a0000';
        }

        let slotsHtml = '';
        if (!d.isBlocked) {
            // Definir horários baseado no dia da semana
            if (d.isSunday) {
                // Domingo: apenas 11h, 14h, 15h
                const sundaySlots = [
                    { hour: '11h', period: 'Manhã' },
                    { hour: '14h', period: 'Tarde' },
                    { hour: '15h', period: 'Tarde' }
                ];
                slotsHtml = sundaySlots.map(s => {
                    const isHourBlocked = d.hourBlocks[s.hour] || false;
                    if (isHourBlocked) {
                        return `<button class="slot-btn" disabled style="opacity:0.3; pointer-events:none; text-decoration:line-through;">${s.hour}</button>`;
                    }
                    const isSuggested = d.suggestedHours && d.suggestedHours[s.hour];
                    const suggestedStyle = isSuggested ? 'border-color: #ffcc00; color: #ffcc00; box-shadow: 0 0 10px #ffcc00; text-shadow: 0 0 5px #ffcc00;' : '';
                    return `<button class="slot-btn" onclick="selectSlot('${d.dateStr}', '${s.period}', this, '${s.hour}')" style="${suggestedStyle}">${s.hour}</button>`;
                }).join('\n');
            } else {
                // Dias normais: mostrar 3 seções com horários
                const sections = [
                    { label: 'Manhã', period: 'Manhã', hours: ['8h', '9h', '10h', '11h'], blocked: d.partialBlocks.manha, color: '#ffcc00' },
                    { label: 'Tarde', period: 'Tarde', hours: ['14h', '15h', '16h'], blocked: d.partialBlocks.tarde, color: '#ff8800' },
                    { label: 'Noite', period: 'Noite', hours: ['17h', '18h', '19h', '20h'], blocked: d.partialBlocks.noite, color: '#aa00ff' }
                ];
                slotsHtml = sections.map(sec => {
                    if (sec.blocked) {
                        return `<div style="margin-top:4px;"><span style="font-size:0.65rem; color:#555; text-decoration:line-through;">${sec.label}</span></div>`;
                    }
                    const btns = sec.hours.map(h => {
                        const isHourBlocked = d.hourBlocks[h] || false;
                        if (isHourBlocked) {
                            return `<button class="slot-btn slot-hour" disabled style="opacity:0.3; pointer-events:none; text-decoration:line-through; font-size:0.7rem; padding:4px 6px; min-width:auto;">${h}</button>`;
                        }
                        const isSuggested = d.suggestedHours && d.suggestedHours[h];
                        const suggestedStyle = isSuggested ? 'border-color: #ffcc00; color: #ffcc00; box-shadow: 0 0 10px #ffcc00; text-shadow: 0 0 5px #ffcc00;' : '';
                        return `<button class="slot-btn slot-hour" onclick="selectSlot('${d.dateStr}', '${sec.period}', this, '${h}')" style="font-size:0.7rem; padding:4px 6px; min-width:auto; ${suggestedStyle}">${h}</button>`;
                    }).join('');
                    return `<div style="margin-top:4px;"><span style="font-size:0.65rem; color:${sec.color}; text-shadow:0 0 8px ${sec.color}; letter-spacing:0.5px; font-weight:bold;">${sec.label}</span><div style="display:flex; flex-wrap:wrap; gap:3px; justify-content:center; margin-top:2px;">${btns}</div></div>`;
                }).join('');
            }
        } else {
            slotsHtml = `<div style="margin-top:20px; font-size:0.8rem; color:#888; font-weight:bold; letter-spacing:1px;">${d.blockedReason}</div>`;
        }

        card.innerHTML = `
            <div class="day-name">${d.dayName.toUpperCase()}</div>
            <div class="day-date">${d.dayNum}</div>
            ${slotsHtml}
        `;
        track.appendChild(card);
    });
}

function updateCarouselPosition() {
    if(!track) return;
    
    // NEW: Modo "Foco Centralizado"
    // Permite navegar até o último item individualmente
    const maxIndex = Math.max(0, daysList.length - 1);
    if (currentIndex < 0) currentIndex = 0;
    if (currentIndex > maxIndex) currentIndex = maxIndex;

    // Calcular deslocamento para CENTRALIZAR o card ativo
    const viewport = document.querySelector('.carousel-viewport');
    const viewportWidth = viewport ? viewport.offsetWidth : window.innerWidth;
    const gap = 20; 
    const cardOnlyWidth = CARD_WIDTH - gap; 
    
    // Posição esquerda do card alvo
    const cardLeftPos = currentIndex * CARD_WIDTH;
    
    // Offset para centralizar: (Tela - LarguraCard) / 2
    const centerOffset = (viewportWidth - cardOnlyWidth) / 2;
    
    // Translation final
    const translateValue = -cardLeftPos + centerOffset;

    track.style.transform = `translateX(${translateValue}px)`;

    // Atualiza estado dos botões
    if(prevBtn) {
        prevBtn.style.opacity = currentIndex === 0 ? '0.3' : '1';
        prevBtn.style.pointerEvents = currentIndex === 0 ? 'none' : 'auto';
    }
    
    if(nextBtn) {
        nextBtn.style.opacity = currentIndex === maxIndex ? '0.3' : '1';
        nextBtn.style.pointerEvents = currentIndex === maxIndex ? 'none' : 'auto';
    }
}

function getVisibleCards() {
    // Mantido para compatibilidade, mas a lógica principal mudou
    const viewport = document.querySelector('.carousel-viewport');
    if(!viewport) return 1;
    return Math.floor(viewport.offsetWidth / CARD_WIDTH);
}

// EVENTOS DE NAVEGAÇÃO
if(prevBtn) {
    prevBtn.addEventListener('click', () => {
        currentIndex--;
        updateCarouselPosition();
    });
}

if(nextBtn) {
    nextBtn.addEventListener('click', () => {
        currentIndex++;
        updateCarouselPosition();
    });
}

window.addEventListener('resize', updateCarouselPosition);

// ADICIONADO: Navegação por Toque (Swipe) - Corrigido
let touchStartX = 0;
let touchEndX = 0;
const viewportEl = document.querySelector('.carousel-viewport'); // Attach to viewport

if (viewportEl) {
    viewportEl.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    }, {passive: true});

    viewportEl.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    }, {passive: true});
}

function handleSwipe() {
    const threshold = 40; // Sensibilidade
    if (touchEndX < touchStartX - threshold) {
        // Swipe Left -> Next
        const maxIndex = Math.max(0, daysList.length - 1); // Atualizado para length-1
        if (currentIndex < maxIndex) {
            currentIndex++;
            updateCarouselPosition();
        }
    } else if (touchEndX > touchStartX + threshold) {
        // Swipe Right -> Prev
        if (currentIndex > 0) {
            currentIndex--;
            updateCarouselPosition();
        }
    }
}

// LÓGICA DE SELEÇÃO E AGENDAMENTO
let selectedDate = null;
let selectedPeriod = null;
let selectedHour = null;

window.selectSlot = function(dateStr, period, btnElement, hour) {
    // Remover classe ativa de todos os botões
    document.querySelectorAll('.slot-btn').forEach(b => {
        b.style.background = 'transparent';
        b.style.color = '#fff';
        b.style.borderColor = '#555';
    });
    
    // Remover classe ativa de todos os cards
    document.querySelectorAll('.date-card').forEach(c => c.classList.remove('active'));

    // Ativar botão clicado
    btnElement.style.background = '#006600';
    btnElement.style.borderColor = '#00ff00';
    btnElement.style.boxShadow = '0 0 10px #00ff00';
    btnElement.style.fontWeight = 'bold';
    btnElement.style.color = '#fff';

    // Ativar card pai
    const card = btnElement.closest('.date-card');
    card.classList.add('active');

    selectedDate = dateStr;
    selectedPeriod = period;
    selectedHour = hour || period;

    // FIX: Parse manual da string YYYY-MM-DD para evitar conversão UTC->Local que causa erro de -1 dia
    const [y, m, d] = dateStr.split('-');
    const formattedDate = `${d}/${m}/${y}`;
    
    document.getElementById('selected-info').innerHTML = `Agendando para: <strong>${formattedDate} às ${selectedHour} (${period})</strong>`;
    
    // MELHORIA: Scrollar para o card selecionado para garantir visibilidade
    const cardIndex = daysList.findIndex(d => d.dateStr === dateStr);
    if (cardIndex !== -1) {
        // Agora apenas focamos diretamente no índice, pois a lógica de centralizar já está em updateCarouselPosition
        if (currentIndex !== cardIndex) {
            currentIndex = cardIndex;
            updateCarouselPosition();
        }
    }

    const form = document.getElementById('booking-form');
    form.style.display = 'block';
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

window.confirmBooking = async function() {
    const nameInput = document.getElementById('client-name');
    const jobSelect = document.getElementById('job-type');
    const healthInput = document.getElementById('client-health');
    const projectInput = document.getElementById('client-project');

    if (!nameInput.value.trim()) {
        showCustomModal("Por favor, digite seu nome completo.");
        nameInput.focus();
        return;
    }
    if (!selectedDate || !selectedPeriod) {
        showCustomModal("Selecione um dia e horário primeiro.");
        return;
    }
    if (!healthInput.value.trim()) {
        showCustomModal("Por favor, informe o local do corpo onde deseja tatuar.");
        healthInput.focus();
        return;
    }
    if (!projectInput.value.trim()) {
        showCustomModal("Descreva se quer algo mais simplificado e barato ou algo mais elaborado em mais sessões, e informe quanto gostaria de investir.");
        projectInput.focus();
        return;
    }

    // FIX: Parse manual da string YYYY-MM-DD para o confirm
    const [y, m, d] = selectedDate.split('-');
    const formattedDate = `${d}/${m}/${y}`;

    const confirmMsg = `Confirma a solicitação?\n\nCliente: ${nameInput.value}\nData: ${formattedDate}\nHorário: ${selectedHour} (${selectedPeriod})\nTipo: ${jobSelect.options[jobSelect.selectedIndex].text}\n\nLocal do corpo: ${healthInput.value}\nComplexidade do projeto: ${projectInput.value}`;
    if(!confirm(confirmMsg)) return;

    const ok = await reservarHorario(
        nameInput.value,
        selectedDate,
        selectedPeriod,
        parseInt(jobSelect.value),
        healthInput.value,
        projectInput.value
    );
    if (ok) {
        await cadastrarCliente(nameInput.value);
        // Montar mensagem para WhatsApp no formato esperado pelo bot
        const tipoTexto = jobSelect.options[jobSelect.selectedIndex].text;
        const msg =
          `SITE: cliente_novo, ${healthInput.value}, ${projectInput.value}\n` +
          `Nome: ${nameInput.value}\n` +
          `Data: ${new Date(selectedDate).toLocaleDateString('pt-BR')}\n` +
          `Período: ${selectedPeriod}\n` +
          `Horário: ${selectedHour}\n` +
          `Tipo: ${tipoTexto}`;
        const phone = '5521976265417';
        const url = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
        window.location.href = url;
    } else {
        showCustomModal("Erro ao realizar agendamento. O horário pode ter sido ocupado.", true);
    }
}

// Modal customizado para mensagens
function showCustomModal(message, isError = false) {
    let modal = document.getElementById('custom-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'custom-modal';
        modal.innerHTML = `
            <div class="modal-bg"></div>
            <div class="modal-content">
                <span id="modal-message"></span>
                <button id="modal-close">OK</button>
            </div>
        `;
        document.body.appendChild(modal);
        document.getElementById('modal-close').onclick = () => {
            modal.style.display = 'none';
        };
    }
    document.getElementById('modal-message').innerText = message;
    modal.querySelector('.modal-content').style.background = isError ? '#2a0000' : '#111';
    modal.querySelector('.modal-content').style.color = isError ? '#ffb3b3' : '#fff';
    modal.style.display = 'flex';
}

// INICIALIZAÇÃO
document.addEventListener('DOMContentLoaded', async () => {
    // Carregar bloqueios ANTES de gerar dias
    // Use try catch para não parar execução
    try {
       await fetchBlockedDays();
    } catch(e) { console.error(e); }

    gerarDias();
    renderCarousel();
    updateCarouselPosition();
    fetchPortfolio();
    fetchConfig(); // Carrega Dicas

    // Show Popup after 1 second, hide after 4 seconds (total 5s from start)
    const popup = document.getElementById('info-popup');
    if(popup) {
        setTimeout(() => {
            popup.style.display = 'block';
            // Trigger reflow
            popup.offsetHeight; 
            popup.classList.add('show');
            
            // Hide after 4s
            setTimeout(() => {
                popup.classList.remove('show');
                setTimeout(() => {
                    popup.style.display = 'none';
                }, 500); // Wait for transition
            }, 4000);
        }, 1000);
    }

    // --- MORE INFO MODAL LOGIC (Integrada aqui para garantir carregamento) ---
    const moreInfoModal = document.getElementById('more-info-modal');
    
    // Expor globalmente para o onclick no HTML
    window.openMoreInfo = function() {
        if(!moreInfoModal) return;
        // Aplica blur em cada elemento individualmente (NUNCA no modal)
        var els = document.querySelectorAll('.background-wrapper, .container, .float-admin-btn, #info-popup');
        for(var i = 0; i < els.length; i++) {
            els[i].style.filter = 'blur(8px)';
            els[i].style.webkitFilter = 'blur(8px)';
            els[i].style.transition = 'filter 0.3s ease';
        }
        moreInfoModal.style.display = 'flex';
        moreInfoModal.style.filter = 'none';
        moreInfoModal.style.webkitFilter = 'none';
        fetchMoreInfo();
    };

    window.closeMoreInfo = function() {
        if(!moreInfoModal) return;
        moreInfoModal.style.display = 'none';
        var els = document.querySelectorAll('.background-wrapper, .container, .float-admin-btn, #info-popup');
        for(var i = 0; i < els.length; i++) {
            els[i].style.filter = '';
            els[i].style.webkitFilter = '';
        }
    };

    if(moreInfoModal) {
        moreInfoModal.addEventListener('click', (e) => {
            if(e.target === moreInfoModal) window.closeMoreInfo();
        });
    }
});


async function fetchMoreInfo() {
    try {
        const contentDiv = document.getElementById('more-info-content');
        if(!contentDiv) return;
        
        if(contentDiv.innerText.indexOf('Carregando') !== -1) {
            contentDiv.style.opacity = 0.5;
        }
        
        // CORREÇÃO CRÍTICA NA URL E STRING
        // O endpoint correto é /api/config para visitantes
        const res = await fetch(`${API_URL}/config`);
        
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        
        // A resposta do /api/config já vem com os campos (info, dicas, etc) no root do objeto
        if (data && data.info) {
            contentDiv.innerText = data.info;
        } else {
             contentDiv.innerText = 'Para saber mais detalhes sobre valores, cuidados pós-tatuagem e agenda, entre em contato pelo WhatsApp.';
        }
        contentDiv.style.opacity = 1;
    } catch (e) { 
        console.error('Erro ao buscar info', e);
        const contentDiv = document.getElementById('more-info-content');
        if(contentDiv) {
             // Fallback visivel para o usuario se a API falhar
             contentDiv.innerText = 'Para saber mais detalhes sobre valores, cuidados pós-tatuagem e agenda, entre em contato pelo WhatsApp.';
             contentDiv.style.opacity = 1;
        }
    }
}

