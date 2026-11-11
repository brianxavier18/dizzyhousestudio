"""
admin_api.py — Endpoints para dashboard admin.

Fornece APIs para visualizar, editar e confirmar agendamentos.
"""
from flask import Blueprint, request, jsonify
import logging
from db import (
    get_agendamentos_pendentes, 
    get_agendamento, 
    atualizar_status_agendamento,
    atualizar_agendamento_data,
    atualizar_pagamento
)
from config import get_logger

logger = get_logger(__name__)

# Blueprint para endpoints admin
admin_bp = Blueprint('admin', __name__, url_prefix='/api/admin')


# ========== ENDPOINTS AGENDAMENTOS ==========

@admin_bp.route('/agendamentos', methods=['GET'])
def listar_agendamentos():
    """
    GET /api/admin/agendamentos
    
    Retorna lista de agendamentos com status.
    Query params:
    - status: 'pendente', 'confirmado', 'concluído' (default: todos)
    - sort: 'criado_em', 'data_agendado' (default: 'criado_em')
    """
    try:
        agendamentos = get_agendamentos_pendentes()
        
        # Filtrar por status se especificado
        status_filter = request.args.get('status')
        if status_filter:
            agendamentos = [a for a in agendamentos if a.get('status') == status_filter]
        
        # Converter para dicts serializáveis
        resultado = []
        for agendamento in agendamentos:
            resultado.append({
                'id': agendamento.get('id'),
                'cliente': agendamento.get('push_name'),
                'jid': agendamento.get('jid'),
                'cliente_tipo': agendamento.get('cliente_tipo'),
                'local': agendamento.get('local'),
                'tamanho': agendamento.get('tamanho'),
                'estilo': agendamento.get('estilo'),
                'valor_total': float(agendamento.get('valor_total', 0)),
                'valor_sinal': float(agendamento.get('valor_sinal', 0)),
                'valor_saldo': float(agendamento.get('valor_saldo', 0)),
                'pagamento_sinal': agendamento.get('pagamento_sinal'),
                'pagamento_restante': agendamento.get('pagamento_restante'),
                'status': agendamento.get('status'),
                'data_agendado': str(agendamento.get('data_agendado')) if agendamento.get('data_agendado') else None,
                'horario_agendado': agendamento.get('horario_agendado'),
                'criado_em': str(agendamento.get('criado_em')) if agendamento.get('criado_em') else None,
                'notas': agendamento.get('notas')
            })
        
        return jsonify({
            'success': True,
            'total': len(resultado),
            'agendamentos': resultado
        })
    
    except Exception as e:
        logger.error(f"Erro ao listar agendamentos: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@admin_bp.route('/agendamentos/<int:agendamento_id>', methods=['GET'])
def detalhes_agendamento(agendamento_id: int):
    """
    GET /api/admin/agendamentos/{id}
    
    Retorna informações detalhadas de um agendamento.
    """
    try:
        agendamento = get_agendamento(agendamento_id)
        
        if not agendamento:
            return jsonify({'success': False, 'error': 'Agendamento não encontrado'}), 404
        
        return jsonify({
            'success': True,
            'agendamento': {
                'id': agendamento.get('id'),
                'cliente': agendamento.get('push_name'),
                'jid': agendamento.get('jid'),
                'cliente_tipo': agendamento.get('cliente_tipo'),
                'local': agendamento.get('local'),
                'tamanho': agendamento.get('tamanho'),
                'estilo': agendamento.get('estilo'),
                'valor_total': float(agendamento.get('valor_total', 0)),
                'valor_sinal': float(agendamento.get('valor_sinal', 0)),
                'valor_saldo': float(agendamento.get('valor_saldo', 0)),
                'pagamento_sinal': agendamento.get('pagamento_sinal'),
                'pagamento_restante': agendamento.get('pagamento_restante'),
                'status': agendamento.get('status'),
                'data_agendado': str(agendamento.get('data_agendado')) if agendamento.get('data_agendado') else None,
                'horario_agendado': agendamento.get('horario_agendado'),
                'criado_em': str(agendamento.get('criado_em')) if agendamento.get('criado_em') else None,
                'atualizado_em': str(agendamento.get('atualizado_em')) if agendamento.get('atualizado_em') else None,
                'notas': agendamento.get('notas')
            }
        })
    
    except Exception as e:
        logger.error(f"Erro ao buscar agendamento {agendamento_id}: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@admin_bp.route('/agendamentos/<int:agendamento_id>/confirmar', methods=['POST'])
def confirmar_agendamento(agendamento_id: int):
    """
    POST /api/admin/agendamentos/{id}/confirmar
    
    Marca agendamento como confirmado e salva data/hora.
    
    Body JSON:
    {
        "data_agendado": "2026-03-15",
        "horario_agendado": "14:00",
        "notas": "Cliente preferencia: manhã"
    }
    """
    try:
        data = request.get_json()
        
        if not data or not data.get('data_agendado') or not data.get('horario_agendado'):
            return jsonify({'success': False, 'error': 'data_agendado e horario_agendado são obrigatórios'}), 400
        
        agendamento = get_agendamento(agendamento_id)
        if not agendamento:
            return jsonify({'success': False, 'error': 'Agendamento não encontrado'}), 404
        
        # Atualizar data/hora
        atualizar_agendamento_data(
            agendamento_id,
            data['data_agendado'],
            data['horario_agendado']
        )
        
        # Atualizar status
        atualizar_status_agendamento(agendamento_id, 'confirmado')
        
        # Confirmar pagamento do sinal
        atualizar_pagamento(agendamento_id, 'confirmado')
        
        logger.info(f"✅ Agendamento {agendamento_id} confirmado para {data['data_agendado']} {data['horario_agendado']}")
        
        return jsonify({
            'success': True,
            'message': f"Agendamento confirmado para {data['data_agendado']} às {data['horario_agendado']}"
        })
    
    except Exception as e:
        logger.error(f"Erro ao confirmar agendamento {agendamento_id}: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@admin_bp.route('/agendamentos/<int:agendamento_id>/cancelar', methods=['POST'])
def cancelar_agendamento(agendamento_id: int):
    """
    POST /api/admin/agendamentos/{id}/cancelar
    
    Cancela agendamento (muda status para 'cancelado').
    """
    try:
        atualizar_status_agendamento(agendamento_id, 'cancelado')
        logger.info(f"❌ Agendamento {agendamento_id} cancelado")
        
        return jsonify({
            'success': True,
            'message': 'Agendamento cancelado'
        })
    
    except Exception as e:
        logger.error(f"Erro ao cancelar agendamento {agendamento_id}: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


# ========== ENDPOINTS DASHBOARD ==========

@admin_bp.route('/dashboard', methods=['GET'])
def dashboard():
    """
    GET /api/admin/dashboard
    
    Retorna estatísticas gerais para o dashboard.
    """
    try:
        todos_agendamentos = get_agendamentos_pendentes()
        
        # Contar por status
        pendentes = len([a for a in todos_agendamentos if a.get('status') == 'pendente'])
        confirmados = len([a for a in todos_agendamentos if a.get('status') == 'confirmado'])
        concluidos = len([a for a in todos_agendamentos if a.get('status') == 'concluído'])
        
        # Somar valores
        valor_total_pendente = sum(float(a.get('valor_sinal', 0)) for a in todos_agendamentos if a.get('status') == 'pendente')
        valor_total_confirmado = sum(float(a.get('valor_total', 0)) for a in todos_agendamentos if a.get('status') == 'confirmado')
        
        # Top estilos
        estilos = {}
        for a in todos_agendamentos:
            estilo = a.get('estilo', 'desconhecido')
            estilos[estilo] = estilos.get(estilo, 0) + 1
        
        return jsonify({
            'success': True,
            'resumo': {
                'agendamentos_pendentes': pendentes,
                'agendamentos_confirmados': confirmados,
                'agendamentos_concluidos': concluidos,
                'valor_pendente': float(valor_total_pendente),
                'valor_confirmado': float(valor_total_confirmado),
                'estilos_populares': estilos
            }
        })
    
    except Exception as e:
        logger.error(f"Erro ao gerar dashboard: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


# ========== HEALTH CHECK ==========

@admin_bp.route('/health', methods=['GET'])
def health():
    """GET /api/admin/health — Verifica saúde da API."""
    return jsonify({'status': 'ok', 'service': 'Drezin Tattoo Bot'})
