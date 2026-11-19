# 라즈베리 파이 설치 및 실행 가이드

이 가이드는 라즈베리 파이에서 이 디스코드 봇 애플리케이션을 실행하는 방법을 설명합니다.

## 1. 필수 프로그램 설치

터미널을 열고 다음 명령어를 입력하여 Node.js와 Git을 설치합니다.

```bash
# 시스템 업데이트
sudo apt update && sudo apt upgrade -y

# Node.js 설치 (버전 18 이상 권장)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Git 설치
sudo apt install -y git

# PM2 설치 (백그라운드 실행 관리 도구)
sudo npm install -g pm2
```

## 2. 프로젝트 다운로드 및 설정

프로젝트 코드를 라즈베리 파이로 가져옵니다. (GitHub 등을 이용하거나 파일을 직접 복사하세요)

```bash
# 프로젝트 폴더로 이동
cd /path/to/your/project

# 의존성 설치
npm install
```

## 3. 환경 변수 설정

`.env` 파일을 생성하고 필요한 설정을 입력합니다.

```bash
nano .env
```

`.env` 파일 내용 예시:

```env
DISCORD_TOKEN=여기에_디스코드_봇_토큰_입력
GEMINI_API_KEY=여기에_GEMINI_API_키_입력 (선택사항)
PORT=3000
```

`Ctrl+X`, `Y`, `Enter`를 차례로 눌러 저장하고 종료합니다.

## 4. 빌드 및 실행

### 개발 모드로 실행 (테스트용)

```bash
npm run dev
```

### 프로덕션 모드로 실행 (실사용)

1. 프론트엔드 빌드
```bash
npm run build
```

2. PM2로 백그라운드 실행
```bash
pm2 start ecosystem.config.cjs
```

3. 로그 확인
```bash
pm2 logs
```

4. 재부팅 시 자동 실행 설정
```bash
pm2 save
pm2 startup
```
(출력되는 명령어를 복사해서 실행하세요)

## 5. 접속 방법

라즈베리 파이의 IP 주소를 확인합니다.

```bash
hostname -I
```

브라우저에서 `http://[라즈베리파이IP]:3000`으로 접속하면 웹 대시보드를 볼 수 있습니다.
