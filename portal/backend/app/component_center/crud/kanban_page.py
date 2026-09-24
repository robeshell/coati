# -*- coding: utf-8 -*-
"""看板页 CRUD 层"""


class KanbanPageCRUD:
    def __init__(self, db, board_model, card_model):
        self.db = db
        self.KanbanBoard = board_model
        self.KanbanCard = card_model

    def all_boards(self):
        return (
            self.KanbanBoard.query
            .order_by(self.KanbanBoard.sort_order)
            .all()
        )

    def get_board_or_404(self, board_id):
        return self.KanbanBoard.query.get_or_404(board_id)

    def get_card_or_404(self, card_id):
        return self.KanbanCard.query.get_or_404(card_id)

    def get_board_by_code(self, code):
        return self.KanbanBoard.query.filter_by(board_code=code).first()

    def get_card_by_code(self, code):
        return self.KanbanCard.query.filter_by(card_code=code).first()

    def add(self, item):
        self.db.session.add(item)

    def delete(self, item):
        self.db.session.delete(item)

    def flush(self):
        self.db.session.flush()

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
