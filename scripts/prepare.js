if (process.env.CI !== 'true') {
  const { execSync } = require('child_process');
  try {
    execSync('npm run setup-hooks', { stdio: 'inherit' });
  } catch (e) {
    process.exit(1);
  }
}
