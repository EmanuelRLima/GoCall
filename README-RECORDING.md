# 📹 Funcionalidade de Gravação e Upload para S3

## 📋 Pré-requisitos

1. **Bucket S3 na AWS** (você mencionou que já tem um preparado)
2. **Credenciais AWS** com permissões de escrita no bucket S3
3. **Node.js** instalado

## 🚀 Configuração

### 1. Instalar dependências

```bash
cd /Users/emanuellima/Documents/Dimendes/WebRTC-libras
npm install
```

Isso instalará:
- `@aws-sdk/client-s3` - Cliente AWS S3
- `@aws-sdk/lib-storage` - Upload gerenciado para S3
- `dotenv` - Variáveis de ambiente
- `multer` - Upload de arquivos

### 2. Configurar variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto:

```bash
cp .env.example .env
```

Edite o arquivo `.env` com suas credenciais AWS:

```env
# AWS S3 Configuration
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=sua_access_key_id_aqui
AWS_SECRET_ACCESS_KEY=sua_secret_access_key_aqui
AWS_S3_BUCKET=nome_do_seu_bucket

# Optional: S3 folder prefix for recordings
S3_RECORDINGS_FOLDER=webrtc-recordings/
```

### 3. Configurar permissões no bucket S3

Certifique-se de que seu bucket S3 tem as seguintes permissões para o usuário IAM:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:PutObject",
                "s3:PutObjectAcl"
            ],
            "Resource": "arn:aws:s3:::seu-bucket/*"
        }
    ]
}
```

## 🎬 Como usar

### 1. Iniciar o servidor

```bash
cd server
node server.js
```

### 2. Acessar a aplicação

Abra o navegador em `http://localhost:3000`

### 3. Gravar uma reunião

1. Entre em uma sala
2. Clique no botão **⏺️** (vermelho) para iniciar a gravação
3. O botão ficará pulsando indicando que está gravando
4. Clique novamente no botão **⏹️** para parar a gravação
5. A gravação será automaticamente:
   - Enviada para o S3
   - Baixada localmente como backup

## 📁 Estrutura dos arquivos no S3

Os arquivos serão salvos no S3 com o seguinte formato:

```
s3://seu-bucket/webrtc-recordings/sala123_1710263456789.webm
```

Formato: `{PASTA_CONFIGURADA}/{ID_DA_SALA}_{TIMESTAMP}.webm`

## 🔧 Características técnicas

### Gravação
- **Formato**: o primeiro que o navegador aceitar entre MP4 (H.264) e WebM (VP9/VP8); o servidor converte o áudio para AAC e entrega MP4
- **Conteúdo**: grade com o vídeo de todos os participantes + áudio mixado de todos (inclusive de quem entra depois do início)
- **Ritmo dos quadros**: relógio num Web Worker (`client/comum.js`). O `requestAnimationFrame` usado antes parava com a aba escondida, e a gravação saía com a imagem congelada e só o áudio andando
- **Chunks**: Dados capturados a cada 1 segundo para evitar perda de dados
- **Conferência**: depois de transcodificar, o servidor lê o arquivo com o ffprobe e manda ao iLibras o evento `gravacao_analisada` (ou `gravacao_com_problema`, com os quadros por segundo)

### Upload
- Upload automático após parar a gravação
- Backup local simultâneo (download automático no navegador)
- Feedback visual do status do upload

## ⚠️ Notas importantes

1. **Tamanho máximo**: `GRAVACAO_MAX_MB` (padrão 1500 MB, cerca de 1h20 a 2,5 Mbps). O `client_max_body_size` do nginx na frente precisa ser maior
2. **Codec**: Chrome e Edge gravam MP4; Firefox grava WebM
3. **Custos AWS**: Lembre-se que uploads e armazenamento no S3 têm custos associados
4. **Segurança**: Nunca commite o arquivo `.env` com suas credenciais (já está no .gitignore)

## 🐛 Troubleshooting

### Erro: "No file uploaded"
- Verifique se a gravação foi iniciada e parada corretamente
- Confirme que há dados gravados antes do upload

### Erro: "AccessDenied"
- Verifique suas credenciais AWS no arquivo `.env`
- Confirme as permissões IAM do usuário
- Verifique se o nome do bucket está correto

### Erro: "Failed to upload recording"
- Verifique a conexão com a internet
- Confirme que o bucket S3 existe
- Verifique os logs do servidor para detalhes

## 🩺 Diagnóstico da chamada

- **Eventos**: cliente e servidor registram o que acontece na chamada (entrou, vídeo conectou e por qual rota, conexão caiu, vídeo parou de chegar, gravação sem vídeo...). Cada evento vira uma linha `[evento] {...}` no log do supervisor e segue em lote para `ILIBRAS_WEBHOOK_URL/api/webhooks/gocall/eventos`, onde fica junto do atendimento e alerta pelo Nightwatch.
- **Teste de equipamento**: `/diagnostico.html` testa câmera, microfone, som, conexão (incluindo o TURN) e grava 10 segundos pelo mesmo caminho da chamada; o servidor confere o arquivo em `/api/diagnostico/gravacao` sem guardar nada. Embutido no iLibras (`?mode=embed`), entrega o resultado à página de cima.
- **TURN**: sem ele, quem está atrás de rede fechada não troca vídeo. Configure `TURN_URLS` + `TURN_SECRET` (coturn com `use-auth-secret`) ou `TURN_USERNAME`/`TURN_CREDENTIAL`. O servidor avisa na subida quando não há TURN.
- **Testes**: `npm test` (credenciais TURN, análise da gravação com ffmpeg/ffprobe de verdade, envio de eventos).

## 📊 Monitoramento

Você pode verificar os uploads no console AWS S3:
1. Acesse o [AWS Console](https://console.aws.amazon.com/s3/)
2. Navegue até seu bucket
3. Acesse a pasta `webrtc-recordings/`

## 🔄 Próximas melhorias possíveis

- [ ] Gravar todo o grid (todos os participantes visíveis)
- [ ] Interface para listar gravações existentes
- [ ] Opção de escolher qualidade de gravação
- [ ] Notificações por email quando gravação é concluída
- [ ] Transcodificação automática para outros formatos
- [ ] Gerenciamento de lifecycle no S3 (arquivamento automático)
