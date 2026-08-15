from setuptools import setup, find_packages

setup(
    name="cli-anything-aseprite",
    version="1.0.0",
    description="CLI harness for the Aseprite pixel-art editor (CLI-Anything)",
    packages=find_packages(),
    install_requires=["click>=8.0", "Pillow>=9.0"],
    entry_points={
        "console_scripts": [
            "cli-anything-aseprite=cli_anything.aseprite.aseprite_cli:main",
        ],
    },
    python_requires=">=3.10",
)
