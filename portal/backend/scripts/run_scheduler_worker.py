#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""独立定时任务 worker 进程入口。"""

from __future__ import annotations

import time

from app import create_app


def main():
    app = create_app(start_scheduler=True, scheduler_force=True)
    print("Scheduled task worker started.")
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        print("Scheduled task worker stopped.")


if __name__ == '__main__':
    main()
