
export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const body = await request.json();
        // Agora esperamos 'credential' do Google (JWT)
        const token = (body.credential || '').trim();

        if (!token) {
            return new Response(JSON.stringify({ erro: 'Credencial Google ausente.' }), { 
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Validação via Google API (Cloudflare Workers fetch)
        const googleRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
        
        if (!googleRes.ok) {
            return new Response(JSON.stringify({ erro: 'Token inválido ou expirado.' }), { 
                status: 401,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const data = await googleRes.json();
        const email = data.email;
        // email_verified vem como string "true" ou boolean true dependendo do endpoint, vamos garantir
        const isVerified = (data.email_verified === true || data.email_verified === 'true');

        // E-mail do administrador, definido nas variáveis de ambiente do Cloudflare Pages.
        const ALLOWED_EMAIL = env.ALLOWED_EMAIL;

        if (isVerified && ALLOWED_EMAIL && email === ALLOWED_EMAIL) {
            return new Response(JSON.stringify({ success: true, email: email, token: 'session-ok' }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        return new Response(JSON.stringify({ 
            erro: `Acesso negado. O e-mail ${email} não tem permissão de administrador.` 
        }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}
