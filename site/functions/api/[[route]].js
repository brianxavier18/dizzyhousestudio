export async function onRequest(context) {
    const { request, env, params } = context;
    const url = new URL(request.url);
    const method = request.method;
    const path = params.route || []; // Array of path segments after /api/

    // --- 1. CORS HELPER (Allow All) ---
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };

    if (method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    // --- 2. DATABASE HELPER (KV) ---
    // If no KV is bound, warn or fallback to memory (which will reset)
    // We assume KV binding name is "DIZZY_KV"
    async function getDB() {
        let data = {
                agendamentos: [],
                clientes: [],
                diasBloqueados: [],
                manualStats: { extraRevenue: 0, extraReservations: 0, manualSlots: null },
                dicas: "Envie suas referências por aqui e também uma foto do local do corpo onde deseja tatuar. Não trabalhamos com cópias de outras tatuagens. O desenho será criado junto com você no dia da sessão!",
                portfolio: [
                        { id: 1, url: 'https://picsum.photos/300/200?random=1', preco: 'R$ 400', desc: 'Old School colorido, braço (2h)' },
                        { id: 2, url: 'https://picsum.photos/300/200?random=2', preco: 'R$ 250', desc: 'Tradicional, antebraço (1h)' },
                        { id: 3, url: 'https://picsum.photos/300/200?random=3', preco: 'R$ 600', desc: 'Fechamento parcial (3h)' },
                        { id: 4, url: 'https://picsum.photos/300/200?random=4', preco: 'R$ 350', desc: 'Lettering clássico (1.5h)' },
                        { id: 5, url: 'https://picsum.photos/300/200?random=5', preco: 'R$ 500', desc: 'Tradicional sombreada (2.5h)' },
                        { id: 6, url: 'https://picsum.photos/300/200?random=6', preco: 'R$ 200', desc: 'Mini tattoo, pulso (1h)' }
                ]
        };

        if (env.DIZZY_KV) {
                const stored = await env.DIZZY_KV.get("DB_DATA", { type: "json" });
                if (stored) {
                         // Merge defaults to ensure new fields exist
                         data = { ...data, ...stored, manualStats: { ...data.manualStats, ...(stored.manualStats || {}) } };
                }
        }
        return data;
    }

    async function saveDB(data) {
        if (env.DIZZY_KV) {
                await env.DIZZY_KV.put("DB_DATA", JSON.stringify(data));
        }
    }

    // Helper JSON Response
    const json = (data, status = 200) => new Response(JSON.stringify(data), { 
            status, 
            headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache" } 
    });

    try {
        // --- 3. ROUTER LOGIC ---
        const db = await getDB();
        const segment1 = path[0];
        const segment2 = path[1];
        const segment3 = path[2];

        // --- AUTH ---
        // Usuário e senha vêm das variáveis de ambiente do Cloudflare Pages (ADMIN_USER / ADMIN_PASS).
        if (segment1 === 'login' && method === 'POST') {
            const body = await request.json();
            const usuario = (body.usuario || '').trim();
            const senha = (body.senha || '').trim();

            if (env.ADMIN_USER && env.ADMIN_PASS && usuario === env.ADMIN_USER && senha === env.ADMIN_PASS) {
                return json({ token: 'fake-cf-token' });
            }
            return json({ erro: 'Credenciais inválidas.' }, 401);
        }

    // --- PUBLIC ENDPOINTS ---
    if (segment1 === 'horarios' && method === 'GET') {
        return json({ agendamentos: db.agendamentos });
    }
    
    if (segment1 === 'bloqueios') {
        if (method === 'GET') {
            // MERGE: Manual Blocks + Real Appointment Slots
            const occupied = db.agendamentos
                .filter(a => a.status !== 'Cancelado' && a.status !== 'Pendente Pagamento')
                .map(a => `${a.data}::${a.periodo}`);
            
            const combined = [...new Set([...(db.diasBloqueados || []), ...occupied])];
            return json(combined);
        }
        if (method === 'POST') {
            const body = await request.json();
            if (!db.diasBloqueados.includes(body.data)) {
                db.diasBloqueados.push(body.data);
                await saveDB(db);
            }
            return json({ success: true, diasBloqueados: db.diasBloqueados });
        }
    }
    // Delete block (param in path? backend uses /:data)
    // path would be ['bloqueios', '2023-01-01']
    if (segment1 === 'bloqueios' && segment2 && method === 'DELETE') {
        const target = decodeURIComponent(segment2);
        db.diasBloqueados = db.diasBloqueados.filter(d => d !== target);
        await saveDB(db);
        return json({ success: true, diasBloqueados: db.diasBloqueados });
    }

    if (segment1 === 'portfolio') {
        if (method === 'GET') {
            try {
                let portfolio = [];
                if (env.DIZZY_KV) {
                    portfolio = await env.DIZZY_KV.get('PORTFOLIO_DATA', { type: 'json' }) || [];
                }
                // Fallback: se vazio, tenta migrar do DB principal
                if (portfolio.length === 0 && db.portfolio && db.portfolio.length > 0) {
                    portfolio = db.portfolio;
                    await env.DIZZY_KV.put('PORTFOLIO_DATA', JSON.stringify(portfolio));
                    // Limpa do DB principal para reduzir tamanho
                    db.portfolio = [];
                    await saveDB(db);
                }
                return json(portfolio);
            } catch (e) {
                return json({ error: 'Erro ao carregar portfólio: ' + e.message }, 500);
            }
        }
        if (method === 'POST') {
            try {
                const body = await request.json();
                const items = body.items || [];
                // Validação: cada item precisa de id, url, preco, desc
                for (const item of items) {
                    if (!item.id || !item.url) {
                        return json({ error: 'Item inválido: falta id ou url' }, 400);
                    }
                }
                if (env.DIZZY_KV) {
                    const payload = JSON.stringify(items);
                    if (payload.length > 24 * 1024 * 1024) {
                        return json({ error: 'Portfólio excede 24MB. Remova fotos ou use imagens menores.' }, 413);
                    }
                    await env.DIZZY_KV.put('PORTFOLIO_DATA', payload);
                }
                return json({ success: true });
            } catch (e) {
                return json({ error: 'Erro ao salvar: ' + e.message }, 500);
            }
        }
        // DELETE: limpa todo o portfólio
        if (method === 'DELETE') {
            try {
                if (env.DIZZY_KV) {
                    await env.DIZZY_KV.put('PORTFOLIO_DATA', '[]');
                    // Limpa também do DB principal se houver
                    db.portfolio = [];
                    await saveDB(db);
                }
                return json({ success: true, message: 'Portfólio limpo' });
            } catch (e) {
                return json({ error: 'Erro ao limpar: ' + e.message }, 500);
            }
        }
    }

    if (segment1 === 'config') {
        const defaults = {
             dicas: "Diga se prefere algo mais simples e econômico ou algo mais detalhado em mais sessões; informe também o valor que gostaria de investir no projeto.",
             info: "Para saber mais detalhes sobre valores, cuidados pós-tatuagem e agenda, entre em contato pelo WhatsApp.",
             label_type1: "Tatuagem Pequena/Média (1 vaga)",
             label_type2: "Tatuagem Grande / Fechamento (2 vagas)",
             label_type3: "",
             label_health: "Local do corpo onde deseja tatuar.",
             label_project: "Complexidade do projeto: descreva se quer algo mais simplificado e barato ou algo mais elaborado em mais sessões. Informe também quanto deseja investir.",
             form_title: "RESERVAR HORÁRIO",
             label_taxa: "Taxa de Reserva: <strong>R$ 100,00</strong>",
             label_btn_confirm: "PAGAR R$ 100 E RESERVAR",
             whatsapp: ""
        };
        const currentConfig = db.config || {};

        if (method === 'GET') {
             return json({ ...defaults, ...currentConfig });
        }
        if (method === 'POST') {
             const body = await request.json();
             db.config = { ...currentConfig, ...body };
             await saveDB(db);
             return json({ success: true, config: db.config });
        }
    }

    if (segment1 === 'agendar' && method === 'POST') {
        const body = await request.json();
        // DEBUG: logar dados recebidos e agendamentos existentes
        const debugInfo = {
            recebido: body,
            agendamentos: db.agendamentos
        };
        // Permitir múltiplos agendamentos para o mesmo horário se status for 'Pendente Pagamento'.
        // Só bloquear se já houver agendamento com status diferente de 'Cancelado' e diferente de 'Pendente Pagamento'.
        const conflito = db.agendamentos.find(a => a.data === body.data && a.periodo === body.periodo && a.status !== 'Cancelado' && a.status !== 'Pendente Pagamento');
        if (conflito) return json({ erro: 'Horário indisponível', debug: debugInfo }, 400);

        const novo = {
            id: Date.now(),
            nome: body.nome,
            data: body.data,
            periodo: body.periodo,
            tipo: body.tipo,
            saude: body.saude || '',
            projeto: body.projeto || '',
            status: 'Pendente Pagamento'
        };
        db.agendamentos.push(novo);
        await saveDB(db);
        return json({ success: true, agendamento: novo, debug: debugInfo });
    }

    // --- ADMIN / AGENDAMENTOS ---
    if (segment1 === 'agendamentos' && segment2) {
        // PUT /api/agendamentos/:id
        if (method === 'PUT') {
            const body = await request.json();
            const idx = db.agendamentos.findIndex(a => a.id == segment2);
            if (idx !== -1) {
                // Update status if provided
                if (body.status) db.agendamentos[idx].status = body.status;
                
                // Update detail fields if provided (Admin Edit)
                if (body.saude !== undefined) db.agendamentos[idx].saude = body.saude;
                if (body.projeto !== undefined) db.agendamentos[idx].projeto = body.projeto;

                await saveDB(db);
                return json({ success: true, agendamento: db.agendamentos[idx] });
            }
            return json({ error: 'Not found' }, 404);
        }
        // DELETE
        if (method === 'DELETE') {
            db.agendamentos = db.agendamentos.filter(a => a.id != segment2);
            await saveDB(db);
            return json({ success: true });
        }
    }

    // --- ADMIN DASHBOARD & LISTS ---
    // /api/admin/...
    if (segment1 === 'admin') {
        if (segment2 === 'agendamentos') {
             if (segment3 === 'manual' && method === 'POST') {
                 const body = await request.json();
                 const novo = { id: Date.now(), origem: 'manual', ...body };
                 db.agendamentos.push(novo);
                 await saveDB(db);
                 return json({ success: true });
             }
             return json({ agendamentos: db.agendamentos });
        }

        if (segment2 === 'clientes') {
            // Editar cliente existente
            if (segment3 && method === 'PUT') {
                const id = segment3;
                const body = await request.json();
                const idx = db.clientes.findIndex(c => c.id == id);
                if (idx !== -1) {
                    db.clientes[idx] = { ...db.clientes[idx], ...body };
                    await saveDB(db);
                    return json({ success: true, cliente: db.clientes[idx] });
                }
                return json({ error: 'Cliente não encontrado' }, 404);
            }
            // Cadastro manual
            if (segment3 === 'manual' && method === 'POST') {
                const body = await request.json();
                db.clientes.push({ id: Date.now(), origem: 'manual', ...body });
                await saveDB(db);
                return json({ success: true });
            }
            // Listar clientes
            return json({ clientes: db.clientes });
        }

        if (segment2 === 'config') {
             if (method === 'POST') {
                 const body = await request.json();
                 db.config = { ...db.config, ...body };
                 await saveDB(db);
                 return json({ success: true, config: db.config });
             }
             return json({ config: db.config || {} });
        }

        if (segment2 === 'dashboard') {
            if (segment3 === 'update' && method === 'POST') {
                const body = await request.json();
                const { action, value } = body;
                if (action === 'addRevenue') db.manualStats.extraRevenue += parseFloat(value);
                if (action === 'addReservation') db.manualStats.extraReservations += parseFloat(value);
                if (action === 'setSlots') db.manualStats.manualSlots = parseInt(value);
                if (action === 'setSlots' && parseInt(value) === -1) db.manualStats.manualSlots = null;
                
                return json({ success: true, manualStats: db.manualStats });
            }

            // GET Dashboard Data Calculation

            // Replicating index.js Logic
            const hojeStr = new Date().toISOString().split('T')[0];
            const agendaHoje = db.agendamentos.filter(a => a.data && a.data.split('T')[0] === hojeStr);
            const active = db.agendamentos.filter(a => a.status !== 'Cancelado');
            let totalReservas = active.length * 100;
            let projecao = totalReservas;
            active.forEach(a => {
                const tipo = parseInt(a.tipo || 1);
                if(tipo === 1) projecao += 300; 
                if(tipo === 2) projecao += 700;
            });
            
            // Manual Addons
            const ms = db.manualStats || { extraRevenue: 0, extraReservations: 0, manualSlots: null };
            totalReservas += (ms.extraReservations || 0);
            projecao += (ms.extraReservations || 0) + (ms.extraRevenue || 0);

            // Vagas
            let vagasRestantes = 0;
            if (ms.manualSlots !== null && ms.manualSlots !== undefined) {
                vagasRestantes = ms.manualSlots;
            } else {
                let ocupadas = 0;
                active.forEach(a => { ocupadas += (parseInt(a.tipo) === 2 ? 2 : 1); });
                const total = 14 * 3;
                vagasRestantes = Math.max(0, total - ocupadas);
            }

            return json({
                agendaHoje,
                financeiro: { totalReservas, projecaoSemana: projecao, manualStats: ms },
                vagasRestantes
            });
        }
    }

    return json({ error: 'Endpoint desconhecido' }, 404);

  } catch (e) {
      return json({ error: e.message }, 500);
  }
}
