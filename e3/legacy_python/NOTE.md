# legacy_python/

The original Python implementation, kept until the Node.js version is verified on your machine.

Only the files that were available during the migration are here: `db.py`, `setup_db.py`,
`test_connection.py`, `requirements.txt`, `README.python.md`.

NOT included (they were not provided): the `db/` package (`connection.py`, `exceptions.py`,
`repositories.py`, `__init__.py`) and `tests/test_engine.py`. If you want the complete old
implementation archived here, copy those from your existing project before deleting it.
The Node.js equivalents of the missing files were written from the README's function table,
the schema and the interface contract, not from the Python source.
