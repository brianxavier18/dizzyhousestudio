"""
db.py — Gerencia conexão e operações com PostgreSQL.

Salva agendamentos, histórico de conversa e dados de pagamento.
"""
import os
import logging
from datetime import datetime
import psycopg2
from psycopg2.extras import DictCursor
from config import get_logger

logger = get_logger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/drezin_tattoo")


class DatabaseManager:
    """Gerenciador de conexão com PostgreSQL."""
    
    def __init__(self, dburl: str = DATABASE_URL):
        self.dburl = dburl
        self.conn = None
    
    def connect(self):
        """Abre conexão com banco."""
        try:
            self.conn = psycopg2.connect(self.dburl)
            logger.info("✅ Conectado ao banco de dados PostgreSQL")
        except Exception as e:
            logger.error(f"❌ Erro ao conectar ao banco: {e}")
            self.conn = None
    
    def execute(self, query: str, params: tuple = ()):
        """Executa query e retorna resultado."""
        if not self.conn:
            self.connect()
        
        try:
            cursor = self.conn.cursor(cursor_factory=DictCursor)
            cursor.execute(query, params)
            self.conn.commit()
            return cursor
        except Exception as e:
            logger.error(f"❌ Erro ao executar query: {e}")
            if self.conn:
                self.conn.rollback()
            return None
    
    def fetch_one(self, query: str, params: tuple = ()):
        """Executa query e retorna uma linha."""
        cursor = self.execute(query, params)
        if cursor:
            return cursor.fetchone()
        return None
    
    def fetch_all(self, query: str, params: tuple = ()):
        """Executa query e retorna todas as linhas."""
        cursor = self.execute(query, params)
        if cursor:
            return cursor.fetchall()
        return []
    
    def close(self):
        """Fecha conexão."""
        if self.conn:
            self.conn.close()
            logger.info("Conexão com banco fechada")


# Instância global
db = DatabaseManager()


# ========== OPERAÇÕES DE AGENDAMENTO ==========

def save_agendamento(jid: str, push_name: str, dados: dict) -> int:
    """
    Salva agendamento de tatuagem no banco.
    Retorna o ID do agendamento.
    """
    query = """
    INSERT INTO agendamentos (
        jid, push_name, cliente_tipo, local, tamanho, estilo,
        valor_total, valor_sinal, valor_saldo,
        pagamento_sinal, pagamento_restante, status, criado_em
    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    RETURNING id;
    """
    
    params = (
        jid,
        push_name,
        dados.get("cliente_tipo"),
        dados.get("local"),
        dados.get("tamanho"),
        dados.get("estilo"),
        dados.get("valor_total"),
        dados.get("valor_sinal"),
        dados.get("valor_saldo"),
        dados.get("pagamento_sinal"),
        dados.get("pagamento_restante"),
        "pendente",  # status
        datetime.now()
    )
    
    cursor = db.execute(query, params)
    if cursor:
        result = cursor.fetchone()
        agendamento_id = result[0] if result else None
        logger.info(f"✅ Agendamento {agendamento_id} salvo para {jid}")
        return agendamento_id
    
    logger.error(f"❌ Erro ao salvar agendamento para {jid}")
    return None


def get_agendamento(agendamento_id: int) -> dict | None:
    """Busca agendamento por ID."""
    query = "SELECT * FROM agendamentos WHERE id = %s;"
    result = db.fetch_one(query, (agendamento_id,))
    return dict(result) if result else None


def get_agendamentos_pendentes() -> list:
    """Retorna todos agendamentos pendentes."""
    query = "SELECT * FROM agendamentos WHERE status = 'pendente' ORDER BY criado_em DESC;"
    results = db.fetch_all(query)
    return [dict(r) for r in results] if results else []


def atualizar_status_agendamento(agendamento_id: int, novo_status: str):
    """Atualiza status (pendente → confirmado → concluído)."""
    query = "UPDATE agendamentos SET status = %s, atualizado_em = %s WHERE id = %s;"
    db.execute(query, (novo_status, datetime.now(), agendamento_id))
    logger.info(f"✅ Status do agendamento {agendamento_id} atualizado para {novo_status}")


def atualizar_agendamento_data(agendamento_id: int, data_agendado: str, horario_agendado: str):
    """Atualiza data e hora da tatuagem (preenchido pelo atendente)."""
    query = """
    UPDATE agendamentos 
    SET data_agendado = %s, horario_agendado = %s, atualizado_em = %s 
    WHERE id = %s;
    """
    db.execute(query, (data_agendado, horario_agendado, datetime.now(), agendamento_id))
    logger.info(f"✅ Data/hora do agendamento {agendamento_id} atualizada")


# ========== OPERAÇÕES DE CONVERSA ==========

def save_conversa(jid: str, push_name: str, mensagem: str, remetente: str):
    """
    Salva mensagem no histórico de conversa.
    remetente: 'usuario' ou 'bot'
    """
    query = """
    INSERT INTO conversas (jid, push_name, mensagem, remetente, timestamp)
    VALUES (%s, %s, %s, %s, %s);
    """
    
    db.execute(query, (jid, push_name, mensagem, remetente, datetime.now()))
    logger.debug(f"💬 Conversa salva: {jid} ({remetente}) — {mensagem[:50]}...")


def get_historico_conversa(jid: str, limit: int = 10) -> list:
    """Retorna últimas mensagens de um contato."""
    query = """
    SELECT * FROM conversas 
    WHERE jid = %s 
    ORDER BY timestamp DESC 
    LIMIT %s;
    """
    results = db.fetch_all(query, (jid, limit))
    return [dict(r) for r in results] if results else []


# ========== OPERAÇÕES DE CONTATO ==========

def save_contato(jid: str, push_name: str):
    """Salva/atualiza contato."""
    # First check if exists
    query_check = "SELECT id FROM contatos WHERE jid = %s;"
    existing = db.fetch_one(query_check, (jid,))
    
    if existing:
        # Update
        query = "UPDATE contatos SET ultimo_contato = %s WHERE jid = %s;"
        db.execute(query, (datetime.now(), jid))
    else:
        # Insert
        query = """
        INSERT INTO contatos (jid, push_name, primeiro_contato, ultimo_contato)
        VALUES (%s, %s, %s, %s);
        """
        db.execute(query, (jid, push_name, datetime.now(), datetime.now()))
    
    logger.debug(f"👤 Contato {jid} salvo/atualizado")


def get_contato(jid: str) -> dict | None:
    """Busca contato por JID."""
    query = "SELECT * FROM contatos WHERE jid = %s;"
    result = db.fetch_one(query, (jid,))
    return dict(result) if result else None


# ========== OPERAÇÕES DE PAGAMENTO ==========

def save_pagamento(agendamento_id: int, metodo: str, valor: float, status: str = "pendente"):
    """
    Salva registro de pagamento.
    metodo: 'pix', 'cartao', 'dinheiro'
    status: 'pendente', 'confirmado', 'falha'
    """
    query = """
    INSERT INTO pagamentos (agendamento_id, metodo, valor, status, criado_em)
    VALUES (%s, %s, %s, %s, %s);
    """
    
    db.execute(query, (agendamento_id, metodo, valor, status, datetime.now()))
    logger.info(f"💰 Pagamento (R$ {valor}) registrado para agendamento {agendamento_id}")


def atualizar_pagamento(agendamento_id: int, novo_status: str):
    """Atualiza status do pagamento."""
    query = """
    UPDATE pagamentos 
    SET status = %s, confirmado_em = %s 
    WHERE agendamento_id = %s 
    ORDER BY id DESC 
    LIMIT 1;
    """
    
    db.execute(query, (novo_status, datetime.now() if novo_status == "confirmado" else None, agendamento_id))
    logger.info(f"💰 Pagamento do agendamento {agendamento_id} marcado como {novo_status}")


# ========== INICIALIZAÇÃO DO BANCO ==========

def init_db():
    """Criar tabelas se não existirem."""
    db.connect()
    
    # Tabela de agendamentos
    query_agendamentos = """
    CREATE TABLE IF NOT EXISTS agendamentos (
        id SERIAL PRIMARY KEY,
        jid VARCHAR(255) NOT NULL UNIQUE,
        push_name VARCHAR(255),
        cliente_tipo VARCHAR(20),  -- 'novo' ou 'vip'
        local VARCHAR(255),
        tamanho VARCHAR(20),       -- '1', '2', '3', '4'
        estilo VARCHAR(50),        -- 'minimalista', 'oldschool', 'preto_cinza
        valor_total DECIMAL(10,2),
        valor_sinal DECIMAL(10,2),
        valor_saldo DECIMAL(10,2),
        pagamento_sinal VARCHAR(20),  -- 'pix', 'cartao'
        pagamento_restante VARCHAR(20),  -- 'pix', 'cartao', 'dinheiro'
        status VARCHAR(50) DEFAULT 'pendente',  -- 'pendente', 'confirmado', 'concluído'
        data_agendado DATE,
        horario_agendado VARCHAR(20),
        criado_em TIMESTAMP DEFAULT NOW(),
        atualizado_em TIMESTAMP DEFAULT NOW(),
        notas TEXT
    );
    """
    
    # Tabela de conversas
    query_conversas = """
    CREATE TABLE IF NOT EXISTS conversas (
        id SERIAL PRIMARY KEY,
        jid VARCHAR(255) NOT NULL,
        push_name VARCHAR(255),
        mensagem TEXT,
        remetente VARCHAR(10),  -- 'usuario' ou 'bot'
        tipo_mensagem VARCHAR(20) DEFAULT 'texto',  -- 'texto', 'audio', 'imagem'
        timestamp TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (jid) REFERENCES contatos(jid) ON DELETE CASCADE
    );
    """
    
    # Tabela de contatos
    query_contatos = """
    CREATE TABLE IF NOT EXISTS contatos (
        id SERIAL PRIMARY KEY,
        jid VARCHAR(255) NOT NULL UNIQUE,
        push_name VARCHAR(255),
        tags TEXT[],
        primeiro_contato TIMESTAMP DEFAULT NOW(),
        ultimo_contato TIMESTAMP DEFAULT NOW()
    );
    """
    
    # Tabela de pagamentos
    query_pagamentos = """
    CREATE TABLE IF NOT EXISTS pagamentos (
        id SERIAL PRIMARY KEY,
        agendamento_id INTEGER NOT NULL,
        metodo VARCHAR(20),  -- 'pix', 'cartao', 'dinheiro'
        valor DECIMAL(10,2),
        status VARCHAR(50) DEFAULT 'pendente',  -- 'pendente', 'confirmado', 'falha'
        criado_em TIMESTAMP DEFAULT NOW(),
        confirmado_em TIMESTAMP,
        FOREIGN KEY (agendamento_id) REFERENCES agendamentos(id) ON DELETE CASCADE
    );
    """
    
    # Índices
    query_indices = """
    CREATE INDEX IF NOT EXISTS idx_agendamentos_status ON agendamentos(status);
    CREATE INDEX IF NOT EXISTS idx_agendamentos_data ON agendamentos(data_agendado);
    CREATE INDEX IF NOT EXISTS idx_conversas_jid ON conversas(jid);
    CREATE INDEX IF NOT EXISTS idx_pagamentos_status ON pagamentos(status);
    """
    
    for query in [query_agendamentos, query_conversas, query_contatos, query_pagamentos, query_indices]:
        try:
            db.execute(query)
            logger.info("✅ Tabela/índice criado com sucesso")
        except Exception as e:
            logger.error(f"❌ Erro ao criar tabela: {e}")
    
    logger.info("✅ Banco de dados inicializado!")


if __name__ == "__main__":
    init_db()
