FROM lscr.io/linuxserver/duplicati:v2.3.0.3_stable_2026-06-10-ls296@sha256:98986271265c9184f844d7e61ce63a60993d8dcfe5f989e4316b374ccebfdaee

RUN apk add --no-cache mysql-client

COPY pre-backup.sh /usr/local/bin/pre-backup.sh
RUN chmod +x /usr/local/bin/pre-backup.sh
