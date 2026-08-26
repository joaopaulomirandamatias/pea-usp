# Implantação no Oracle Linux

A aplicação roda em `127.0.0.1:4173` por meio do serviço `pea-usp`. O Nginx
publica a área do aluno na porta 80. O painel e as APIs administrativas só são
aceitos a partir do loopback da VM; use um túnel SSH para administrá-los:

```bash
ssh -N -L 8080:127.0.0.1:80 oracle-usp
```

Com o túnel ativo, abra `http://127.0.0.1:8080/admin.html`.

O SQLite (`disciplinas.db`) e `uploads/` ficam em `/opt/pea-usp` e não são
versionados. Faça backup desses dois itens antes de substituir ou mover a VM.

## DNS

- `A` para `@` apontando para `140.238.179.94`;
- `CNAME` para `www` apontando para `pea-usp.com.br`;
- TTL inicial de 300 segundos.

Depois da propagação do DNS, configure HTTPS antes de divulgar o endereço.
