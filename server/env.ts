import { existsSync } from 'node:fs';

// 로컬 개발용 .env를 읽는다. 이미 설정된 환경변수는 덮어쓰지 않는다.
// 다른 서버 모듈보다 먼저 import 되어야 설정값이 반영된다.
if (existsSync('.env')) process.loadEnvFile('.env');
