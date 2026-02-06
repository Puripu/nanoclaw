
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
    {
        ignores: ['dist/', 'node_modules/', 'groups/', 'container/'],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.node,
            },
            parserOptions: {
                project: './tsconfig.eslint.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
        },
    }
);
